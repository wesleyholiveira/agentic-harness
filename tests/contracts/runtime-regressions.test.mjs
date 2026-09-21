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

function rustInfoEventPattern(event) {
  const escaped = event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`info!\\s*\\(\\s*event\\s*=\\s*"${escaped}"`);
}

test("runtime worker logging is visible by default and remains operator-overridable", () => {
  const main = source("apps/runtime-worker/src/main.rs");
  const compose = source("compose.yaml");
  const envExample = source(".env.example");
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");

  assert.match(main, /EnvFilter::try_from_default_env\(\)/);
  assert.match(main, /EnvFilter::new\("info"\)/);
  assert.match(main, rustInfoEventPattern("agent_runtime.worker_starting"));
  assert.match(compose, /RUST_LOG:\s*\$\{AGENT_HARNESS_RUNTIME_LOG_FILTER:-info\}/);
  assert.match(envExample, /AGENT_HARNESS_RUNTIME_LOG_FILTER=info/);

  for (const lifecycleEvent of [
    "agent_runtime.execution_preparing",
    "agent_runtime.workspace_ready",
    "agent_runtime.executor_spawned",
    "agent_runtime.executor_completed",
    "agent_runtime.execution_result_persisted",
  ]) {
    assert.match(worker, rustInfoEventPattern(lifecycleEvent));
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

test("runtime-worker Cargo.lock disambiguates the direct hmac 0.12 dependency", () => {
  const lock = source("apps/runtime-worker/Cargo.lock");
  const start = lock.indexOf('name = "agentic-harness-worker"');
  const end = lock.indexOf("\n[[package]]", start);
  assert.ok(start >= 0 && end > start);
  const rootPackage = lock.slice(start, end);
  assert.match(rootPackage, /"hmac 0\.12\.1"/);
  assert.doesNotMatch(rootPackage, /\n "hmac",/);
  const dockerfile = source("apps/runtime-worker/Dockerfile");
  assert.match(dockerfile, /cargo build --locked --release --manifest-path apps\/runtime-worker\/Cargo\.toml/);
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


test("typed behavior gateway executes only after agent completion under the existing task fence", () => {
  const preparation = source(".agents/runtime/event-driven-preparation.mjs");
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  const gateway = source("apps/runtime-worker/src/behavior_gateway.rs");
  const finalizer = source(".agents/runtime/event-driven-finalizer.mjs");

  assert.match(preparation, /behavior-gate-descriptor\/v1/);
  assert.match(preparation, /commandAuthority/);
  assert.match(preparation, /commandSpecIds/);
  assert.match(preparation, /behaviorGate/);

  assert.match(worker, /behavior_gate:\s*Option<BehaviorGateDescriptor>/);
  assert.match(worker, /run_behavior_gateway_under_lease/);
  assert.match(worker, /behavior\.gateway\.capability/);
  assert.match(worker, /capability_proof\(hmac_key, &capability, &fence\)/);
  assert.match(worker, /status\.success\(\)[\s\S]*descriptor\.behavior_gate\.as_ref\(\)/);
  assert.match(worker, /behavior\.gateway\.started/);
  assert.match(worker, /behavior\.gateway\.completed/);
  assert.match(worker, /lease_owner=\$3[\s\S]*dispatch_generation=\$4[\s\S]*fencing_token=\$5/);

  assert.match(gateway, /Uuid::new_v4\(\)\.simple\(\)/);
  assert.match(gateway, /behavior_gateway_url_required/);
  assert.match(gateway, /docker-behavior-gateway-request\/v1/);

  assert.match(finalizer, /behavior\.gateway\.result/);
  assert.match(finalizer, /behavior_validation_failed/);
  assert.match(finalizer, /behavior_gateway_hold/);
});

test("model-controlled executor child cannot inherit Runtime infrastructure credentials", () => {
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  assert.match(worker, /command\.env_remove\(sensitive\)/);
  for (const key of [
    "AGENT_POSTGRES_URL",
    "DATABASE_URL",
    "AGENT_HARNESS_RUNTIME_RABBITMQ_URL",
    "AGENT_HARNESS_DOCKER_GATEWAY_URL",
    "AGENT_HARNESS_DOCKER_GATEWAY_HMAC_KEY",
  ]) {
    assert.ok(worker.includes(`"${key}"`));
  }
});

test("Docker gateway capability is fence-bound in PostgreSQL and no permanent bearer token remains", () => {
  const gateway = source("apps/docker-gateway/server.mjs");
  const fenceStore = source("apps/docker-gateway/fence-store.mjs");
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  const compose = source("compose.yaml");

  assert.match(gateway, /capability/);
  assert.match(gateway, /createPostgresCapabilityVerifier/);
  assert.doesNotMatch(gateway, /timingSafeEqual/);
  assert.doesNotMatch(gateway, /Bearer /);
  assert.match(fenceStore, /behavior\.gateway\.capability/);
  assert.match(fenceStore, /lease_owner/);
  assert.match(fenceStore, /lease_expires_at/);
  assert.match(fenceStore, /gatewayCapabilityProof/);
  assert.match(fenceStore, /createHmac\('sha256'/);
  assert.match(worker, /capability_proof/);

  const gatewayBlock = compose.split("  docker-behavior-gateway:")[1]?.split("\n  agent-runtime-worker:")[0] ?? "";
  const workerBlock = compose.split("  agent-runtime-worker:")[1]?.split("\nvolumes:")[0] ?? "";
  assert.match(gatewayBlock, /AGENT_POSTGRES_URL:/);
  assert.doesNotMatch(gatewayBlock, /AGENT_HARNESS_DOCKER_GATEWAY_TOKEN/);
  assert.doesNotMatch(workerBlock, /AGENT_HARNESS_DOCKER_GATEWAY_TOKEN/);
  assert.match(workerBlock, /AGENT_HARNESS_DOCKER_GATEWAY_URL:/);
});


test("typed behavior tasks drop child privileges and kill the isolated process group before minting gateway capability", () => {
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  const dockerfile = source("apps/runtime-worker/Dockerfile");

  assert.match(dockerfile, /agentexec:x:10001:10001/);
  assert.match(worker, /BEHAVIOR_AGENT_UID: u32 = 10_001/);
  assert.match(worker, /command\.uid\(BEHAVIOR_AGENT_UID\)/);
  assert.match(worker, /command\.gid\(BEHAVIOR_AGENT_GID\)/);
  assert.match(worker, /command\.process_group\(0\)/);
  assert.match(worker, /prepare_restricted_behavior_agent/);
  assert.match(worker, /terminate_isolated_process_group\(pid\)\.await/);

  const drain = worker.indexOf('drain_executor_output(stdout_task, "stdout", claimed, client).await');
  const terminate = worker.indexOf("terminate_isolated_process_group(pid).await", drain);
  const homeCleanup = worker.indexOf("behavior_agent_home_cleanup_after_execution_failed", terminate);
  const capability = worker.indexOf("run_behavior_gateway_under_lease", drain);
  assert.ok(drain >= 0 && terminate > drain && homeCleanup > terminate && capability > homeCleanup);
});
