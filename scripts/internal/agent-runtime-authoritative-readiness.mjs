#!/usr/bin/env node
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveDatabaseAppUrl } from "../../.agents/runtime/database-config.mjs";
import { probeSessionHost } from "../../.agents/runtime/session-host-readiness.mjs";
import { OrchestrationStore } from "../../.agents/runtime/store.mjs";
import { loadEnvFile, parseArgs } from "../../.agents/runtime/utils.mjs";

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = resolve(String(args.repository ?? process.cwd()));
await loadEnvFile(join(repositoryRoot, ".env"));
const waitMs = Math.max(1_000, Number(args.waitMs ?? process.env.AGENT_HARNESS_AGENT_AUTHORITATIVE_READINESS_WAIT_MS ?? 60_000));
const pollMs = Math.max(250, Number(args.pollMs ?? 1_000));
const minConcurrency = Math.max(1, Number(process.env.AGENT_HARNESS_RUNTIME_MIN_WORKER_CONCURRENCY ?? 3));
const databaseUrl = resolveDatabaseAppUrl(process.env);
if (!databaseUrl) throw new Error("database_app_url_required");
const databaseSchema = String(args.databaseSchema ?? process.env.AGENT_POSTGRES_SCHEMA ?? process.env.DATABASE_SCHEMA ?? "public");

const store = await new OrchestrationStore(databaseUrl, { schema: databaseSchema }).open();
let worker = null;
try {
  const deadline = Date.now() + waitMs;
  do {
    worker = await store.runtimeWorkerHealth();
    if (worker?.healthy) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
} finally {
  await store.close();
}

const sessionHost = await probeSessionHost({ environment: process.env, timeoutMs: 3_000 });
const workerFresh = Boolean(worker?.healthy);
const workerConcurrencyReady = Number(worker?.concurrency ?? 0) >= minConcurrency;
const sessionHostReady = !sessionHost.required || (sessionHost.configured && sessionHost.healthy);
const ok = workerFresh && workerConcurrencyReady && sessionHostReady;
let code = "agent_runtime_authoritative_ready";
let exitCode = 0;
if (!workerFresh) {
  code = "agent_runtime_worker_not_fresh_after_restart";
  exitCode = 1;
} else if (!workerConcurrencyReady) {
  code = "agent_runtime_worker_concurrency_below_minimum";
  exitCode = 1;
} else if (!sessionHostReady) {
  code = "agent_runtime_session_host_prerequisite_unavailable";
  exitCode = 2;
}

const report = {
  ok,
  code,
  worker: worker ? {
    workerId: worker.worker_id,
    healthy: worker.healthy,
    heartbeatAt: worker.heartbeat_at,
    ageMs: worker.ageMs,
    concurrency: worker.concurrency,
    minimumConcurrency: minConcurrency,
  } : null,
  sessionHost,
  operatorAction: exitCode === 2
    ? [
        "Start the persistent OpenCode session host: opencode serve --hostname 0.0.0.0 --port 4096",
        "Attach the TUI to the same host: opencode attach http://127.0.0.1:4096",
        "Then rerun the authoritative harness validation.",
      ]
    : [],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = exitCode;
