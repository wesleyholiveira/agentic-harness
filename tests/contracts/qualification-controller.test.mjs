import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("standalone qualification is a deterministic external controller, not the Main Orchestrator", () => {
  const publicLauncher = readFileSync(resolve(root, "bin/harness.mjs"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts/harness-qualify.mjs"), "utf8");
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const main = JSON.parse(readFileSync(resolve(root, ".opencode/agents.generated.json"), "utf8"))["main-orchestrator"];

  assert.match(publicLauncher, /case "qualify": run\(process\.execPath, \[resolve\(harnessRoot, "scripts\/harness-qualify\.mjs"\), \.\.\.rest\]\)/);
  assert.match(launcher, /scripts["'],\s*["']qualification["'],\s*["']standalone-v1\.mjs/);
  assert.match(launcher, /spawnSync\(command, args,[\s\S]*?shell:\s*false/);
  assert.match(controller, /ProcessRunner/);
  assert.match(controller, /prompt_async/);
  assert.match(controller, /waitForRunId/);
  assert.doesNotMatch(controller, /context-engine_agent_start/);
  assert.doesNotMatch(controller, /requestJson\([^\n]*\/mcp/);

  assert.equal(Object.keys(pkg.scripts).length, 10);
  assert.equal(pkg.scripts["harness:qualify"], "node bin/harness.mjs qualify");
  assert.equal(main.permission.bash, "deny");
  assert.equal(main.permission.edit, "deny");
  assert.deepEqual(main.permission.task, { "*": "deny" });
  assert.equal(main.permission["serena_*"], "deny");
});

test("qualification controller self-test is shell-independent from the Main Orchestrator and emits a structured report", () => {
  const output = mkdtempSync(join(tmpdir(), "agentic-harness-qualification-selftest-"));
  try {
    const result = spawnSync(process.execPath, [resolve(root, "scripts/qualification/standalone-v1.mjs"), "--self-test", "--output", output], {
      cwd: root,
      env: { ...process.env, AGENT_HARNESS_ROOT: root },
      encoding: "utf8",
      shell: false,
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(resolve(output, "qualification-report.json"), "utf8"));
    assert.equal(report.contractVersion, "agentic-harness-standalone-qualification/v1");
    assert.equal(report.verdict, "PASS");
    assert.equal(report.firstDivergence, null);
    assert.equal(report.gates.find((gate) => gate.name === "Q-ENTRY")?.result, "PASS");
    assert.equal(report.gates.find((gate) => gate.name === "R-11")?.result, "PASS");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("qualification process runner resolves Windows .cmd shims without shell:true", async () => {
  const shimDir = mkdtempSync(join(tmpdir(), "agentic-harness-win-shim-"));
  try {
    const shim = resolve(shimDir, "npm.CMD");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(shim, "@echo off\r\n", "utf8");
    const { resolveSpawnInvocation } = await import("../../scripts/qualification/lib/process.mjs");
    const invocation = resolveSpawnInvocation("npm", ["ci"], {
      platform: "win32",
      env: {
        Path: shimDir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
    });
    assert.equal(invocation.resolvedCommand, shim);
    assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(invocation.wrapper, "cmd.exe");
    assert.equal(invocation.windowsVerbatimArguments, true);
    assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
    assert.equal(invocation.args[4], `""${shim}" "ci""`);
    assert.doesNotMatch(invocation.args[4], /\bcall\b/i);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
});


test("Windows batch invocation uses cmd /S /C outer quoting without backslash-escaped executable quotes", async () => {
  const { resolveSpawnInvocation } = await import("../../scripts/qualification/lib/process.mjs");
  const tempRoot = mkdtempSync(join(tmpdir(), "agentic-harness-win space-"));
  try {
    const { writeFileSync } = await import("node:fs");
    const shim = resolve(tempRoot, "npm.CMD");
    writeFileSync(shim, "@echo off\r\n", "utf8");
    const invocation = resolveSpawnInvocation("npm", ["--version"], {
      platform: "win32",
      env: {
        Path: tempRoot,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
    });
    assert.equal(invocation.windowsVerbatimArguments, true);
    assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
    assert.equal(invocation.args[4], `""${shim}" "--version""`);
    assert.doesNotMatch(invocation.args[4], /\\"/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("qualification product-namespace scanner does not self-match outside historical baseline", () => {
  const pattern = [
    ["clip", "compass"].join("-"),
    ["Clip", "Compass"].join(" "),
    ["clip", "compass"].join("_"),
    ["CLIP", "COMPASS"].join("_"),
  ].join("|");
  const result = spawnSync("git", [
    "-C",
    root,
    "grep",
    "-niE",
    pattern,
    "--",
    ":!qualification/baseline/r17.4.5/**",
  ], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
});



test("qualification HTTP layer preserves transport cause and request authority", async () => {
  const { requestJson } = await import("../../scripts/qualification/lib/http.mjs");
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolvePromise) => server.close(resolvePromise));

  await assert.rejects(
    requestJson(`http://127.0.0.1:${port}/healthz`, {
      timeoutMs: 500,
      allowStatuses: [200],
    }),
    (error) => {
      assert.equal(error.code, "qualification_http_transport_failed");
      assert.equal(error.evidence.url, `http://127.0.0.1:${port}/healthz`);
      assert.equal(error.evidence.method, "GET");
      assert.equal(error.evidence.timeoutMs, 500);
      assert.equal(typeof error.evidence.cause?.code, "string");
      return true;
    },
  );
});

test("qualification HTTP readiness retries transient 503 and records attempt evidence", async () => {
  const { waitForJsonReady } = await import("../../scripts/qualification/lib/http.mjs");
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    if (requests < 3) {
      response.statusCode = 503;
      response.end(JSON.stringify({ ready: false }));
      return;
    }
    response.statusCode = 200;
    response.end(JSON.stringify({ ready: true }));
  });

  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  try {
    const result = await waitForJsonReady(`http://127.0.0.1:${port}/ready`, {
      request: { allowStatuses: [200], timeoutMs: 500 },
      timeoutMs: 2_000,
      intervalMs: 10,
      label: "test-service",
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.attempts, 3);
    assert.equal(requests, 3);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("R-4 uses bounded HTTP readiness for Context Engine, RabbitMQ management, and embeddings", () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  assert.match(controller, /service:\s*"context-engine"/);
  assert.match(controller, /service:\s*"rabbitmq-management"/);
  assert.match(controller, /service:\s*"context-embeddings"/);
  assert.match(controller, /qualification_http_readiness_rejected/);
  assert.doesNotMatch(
    controller,
    /await requestJson\(`http:\/\/127\.0\.0\.1:\$\{state\.ports\.rabbitmqManagement\}\/api\/overview`/,
  );
});

test("R-7 discovers Runtime run identity independently of durable continuation and then requires the binding", () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  assert.match(controller, /SELECT run_id,status,created_at FROM agent_runs WHERE request=/);
  assert.match(controller, /requireDurableContinuation\(runId, sessionId/);
  assert.match(controller, /r7_run_created_without_durable_continuation/);
  assert.match(controller, /r7_main_orchestrator_failed_to_enter_runtime/);
  assert.match(controller, /r7_agent_start_provenance_log_seen_but_run_not_materialized/);
});

test("persistent Main Orchestrator captures runtime-continuation before agent_start", () => {
  const prompt = readFileSync(resolve(root, ".agents/agents/main-orchestrator/AGENT.md"), "utf8");
  const skill = readFileSync(resolve(root, ".agents/skills/operate-multi-agent-runtime/SKILL.md"), "utf8");
  const promptContinuation = prompt.indexOf("`runtime-continuation`");
  const promptStart = prompt.indexOf("`agent_start`");
  assert.ok(promptContinuation >= 0 && promptContinuation < promptStart);
  assert.match(prompt, /pass the captured `continuation` object in the same call/);
  assert.match(prompt, /next = "session-resume-event"/);

  const skillContinuation = skill.indexOf("`runtime-continuation`");
  const skillStart = skill.indexOf("`agent_start`");
  assert.ok(skillContinuation >= 0 && skillContinuation < skillStart);
  assert.match(skill, /that continuation object in the same call/);
});


test("R-7 classifies attempted agent_start schema rejection separately from missing Runtime ingress", () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  assert.match(controller, /r7_agent_start_rejected_by_runtime_validation/);
  assert.match(controller, /r7_agent_start_attempted_but_no_run_materialized/);
  assert.match(controller, /agentStartAttempted/);
  assert.match(controller, /additional property not allowed/);
});


test("R-7 provenance proof is server-enforced and does not depend on optional Context Engine logs", () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  const runtimeTool = readFileSync(resolve(root, "apps/context-engine/src/tools/agent-runtime.ts"), "utf8");

  assert.doesNotMatch(controller, /r7_provenance_registration_not_proven/);
  assert.match(controller, /context-engine-agent-start-fail-closed/);
  assert.match(controller, /opencode-plugin-sidechannel/);

  assert.match(runtimeTool, /function assertRuntimeIngressProvenance/);
  assert.match(runtimeTool, /invocationProvenanceSource !== "opencode-plugin-sidechannel"/);
  assert.match(runtimeTool, /invocationSessionId/);
  assert.match(runtimeTool, /invocationUserMessageId/);
  assert.match(runtimeTool, /agent_control_invocation_provenance_required/);
  assert.match(runtimeTool, /assertRuntimeIngressProvenance\("agent_start"\)/);
});


test("R-7 terminal wait is progress-aware instead of using a blind 45-minute wall-clock deadline", () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  assert.match(controller, /runtimeRunObservation/);
  assert.match(controller, /evaluateRuntimeObservation/);
  assert.match(controller, /formatRuntimeProgress/);
  assert.match(controller, /progress_aware_watch_safety_ceiling/);
  assert.match(controller, /console\.error\(`\[qualification\]\[\$\{gate\}\]/);
  assert.doesNotMatch(controller, /timeoutMs\s*=\s*45\s*\*\s*60_000/);
  assert.doesNotMatch(controller, /qualification_wait_timeout:R-7-terminal-run/);
});

test("R-7 watchdog permits a healthy long-running non-governance task below the Runtime hard timeout", async () => {
  const { evaluateRuntimeObservation } = await import("../../scripts/qualification/lib/runtime-watchdog.mjs");
  const nowMs = Date.parse("2026-09-06T03:00:00.000Z");
  const observation = {
    run: { status: "running" },
    worker: { workerId: "worker-1", heartbeatAt: new Date(nowMs - 5_000).toISOString() },
    tasks: [{
      taskId: "run:implementation",
      stage: "implementation",
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      startedAt: new Date(nowMs - 50 * 60_000).toISOString(),
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(nowMs + 30_000).toISOString(),
      heartbeat: {
        at: new Date(nowMs - 5_000).toISOString(),
        idleMs: 50 * 60_000,
        elapsedMs: 50 * 60_000,
      },
      latestEvent: { type: "task.running", at: new Date(nowMs - 50 * 60_000).toISOString() },
      livenessPolicy: {
        hardTimeoutMs: 60 * 60_000,
        softTimeoutMs: null,
        stallTimeoutMs: null,
      },
    }],
  };

  const result = evaluateRuntimeObservation(observation, { nowMs });
  assert.equal(result.terminal, null);
  assert.equal(result.violation, null);
});

test("R-7 watchdog fails when Runtime leaves a task running beyond its own soft timeout", async () => {
  const { evaluateRuntimeObservation } = await import("../../scripts/qualification/lib/runtime-watchdog.mjs");
  const nowMs = Date.parse("2026-09-06T03:00:00.000Z");
  const observation = {
    run: { status: "running" },
    worker: { workerId: "worker-1", heartbeatAt: new Date(nowMs - 5_000).toISOString() },
    tasks: [{
      taskId: "run:architecture-review",
      stage: "architecture-review",
      status: "running",
      attempt: 1,
      maxAttempts: 2,
      startedAt: new Date(nowMs - 32 * 60_000).toISOString(),
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(nowMs + 30_000).toISOString(),
      heartbeat: {
        at: new Date(nowMs - 5_000).toISOString(),
        idleMs: 60_000,
        elapsedMs: 32 * 60_000,
      },
      latestEvent: { type: "task.running", at: new Date(nowMs - 32 * 60_000).toISOString() },
      livenessPolicy: {
        hardTimeoutMs: 60 * 60_000,
        softTimeoutMs: 30 * 60_000,
        stallTimeoutMs: 12 * 60_000,
      },
    }],
  };

  const result = evaluateRuntimeObservation(observation, { nowMs });
  assert.equal(result.terminal, null);
  assert.equal(result.violation?.message, "runtime_task_exceeded_soft_timeout");
});

test("R-7 watchdog exposes terminal state and detects scheduler inactivity", async () => {
  const { evaluateRuntimeObservation } = await import("../../scripts/qualification/lib/runtime-watchdog.mjs");
  const nowMs = Date.parse("2026-09-06T03:00:00.000Z");

  const terminal = evaluateRuntimeObservation({
    run: { status: "closed", errorCode: "", errorMessage: "" },
    tasks: [],
  }, { nowMs });
  assert.equal(terminal.terminal?.status, "closed");
  assert.equal(terminal.violation, null);

  const inactiveSinceMs = nowMs - 4 * 60_000;
  const stalled = evaluateRuntimeObservation({
    run: { status: "running" },
    worker: { workerId: "worker-1", heartbeatAt: new Date(nowMs - 5_000).toISOString() },
    tasks: [{
      taskId: "run:technical-refinement",
      stage: "technical-refinement",
      status: "routed",
      attempt: 0,
      maxAttempts: 2,
      retryNotBefore: null,
      latestEvent: { type: "task.routed", at: new Date(inactiveSinceMs).toISOString() },
    }],
    recentEvents: [],
  }, { nowMs, inactiveSinceMs });

  assert.equal(stalled.terminal, null);
  assert.equal(stalled.violation?.message, "runtime_scheduler_stalled_without_active_execution");
});
