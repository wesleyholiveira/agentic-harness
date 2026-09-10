import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRetryBudget } from "../../.agents/runtime/retry-efficiency.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function source(path) {
  return readFileSync(resolve(root, path), "utf8");
}

test("runtime worker logging is visible by default and remains operator-overridable", () => {
  const main = source("apps/runtime-worker/src/main.rs");
  const compose = source("compose.yaml");
  const envExample = source(".env.example");
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");

  assert.match(main, /EnvFilter::try_from_default_env\(\)/);
  assert.match(main, /EnvFilter::new\("info"\)/);
  assert.match(main, /info!\(event="agent_runtime\.worker_starting"/);
  assert.match(compose, /RUST_LOG:\s*\$\{AGENT_HARNESS_RUNTIME_LOG_FILTER:-info\}/);
  assert.match(envExample, /AGENT_HARNESS_RUNTIME_LOG_FILTER=info/);

  for (const lifecycleEvent of [
    "agent_runtime.execution_preparing",
    "agent_runtime.workspace_ready",
    "agent_runtime.executor_spawned",
    "agent_runtime.executor_completed",
    "agent_runtime.execution_result_persisted",
  ]) {
    assert.match(worker, new RegExp(`info!\\(event=\\"${lifecycleEvent.replaceAll(".", "\\.")}\\"`));
  }
});

test("stalled executor output draining is bounded so inherited pipes cannot hold a lease open", () => {
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  assert.match(worker, /const OUTPUT_DRAIN_TIMEOUT_MS: u64 = 5_000/);
  assert.match(worker, /timeout\(Duration::from_millis\(OUTPUT_DRAIN_TIMEOUT_MS\), &mut task\)/);
  assert.match(worker, /task\.abort\(\)/);
  assert.match(worker, /executor\.output_drain_timed_out/);
  assert.match(worker, /drain_executor_output\(stdout_task, "stdout", claimed, client\)\.await/);
  assert.match(worker, /drain_executor_output\(stderr_task, "stderr", claimed, client\)\.await/);
});

test("retry wall-clock budget cannot be bypassed by a zero-delay retry", () => {
  const limits = { maxElapsedMs: 900_000, maxCumulativeBackoffMs: 300_000 };
  assert.equal(evaluateRetryBudget({ budgetState: { elapsedMs: 899_999, cumulativeBackoffMs: 0 }, retryAfterMs: 0, limits }).allowed, true);
  assert.equal(evaluateRetryBudget({ budgetState: { elapsedMs: 900_000, cumulativeBackoffMs: 0 }, retryAfterMs: 0, limits }).allowed, false);
  assert.equal(evaluateRetryBudget({ budgetState: { elapsedMs: 1_796_215, cumulativeBackoffMs: 0 }, retryAfterMs: 0, limits }).allowed, false);
});

test("TEI 1.8.x is explicitly configured to truncate semantic descriptors to model capacity", () => {
  const compose = source("compose.yaml");
  assert.match(compose, /text-embeddings-inference:cpu-1\.8\.3/);
  assert.match(compose, /context-embeddings:[\s\S]*command: \["--model-id",[^\n]+"--auto-truncate"\]/);
});
