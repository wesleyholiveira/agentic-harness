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

test("OpenCode failure runtime event is persisted by the semantic finalizer", () => {
  const finalizer = source(".agents/runtime/event-driven-finalizer.mjs");
  assert.match(finalizer, /"opencode\.failure"/u);
  assert.match(finalizer, /BUFFERED_PERFORMANCE_EVENT_TYPES/u);
});

test("OpenCode nonzero JSON failure is reduced to redacted structured evidence", async () => {
  const { summarizeOpenCodeFailure } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const stdout = JSON.stringify({
    type: "error",
    timestamp: 1790115000000,
    sessionID: "ses_failure",
    error: {
      name: "ProviderAuthError",
      data: {
        message: "request rejected Bearer sk-secret-token-12345678",
        code: "401",
        providerID: "openai",
        modelID: "gpt-5.6-luna",
      },
    },
  });
  assert.deepEqual(summarizeOpenCodeFailure({ stdout }), {
    source: "json-error-event",
    sessionId: "ses_failure",
    errorName: "ProviderAuthError",
    errorCode: "401",
    errorRef: null,
    errorMessage: "request rejected Bearer [REDACTED]",
    providerId: "openai",
    modelId: "gpt-5.6-luna",
    serverLogExcerpt: null,
  });
});

test("OpenCode UnknownError diagnostics preserve the bounded server reference", async () => {
  const { summarizeOpenCodeFailure } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const stdout = JSON.stringify({
    type: "error",
    sessionID: "ses_unknown",
    error: {
      name: "UnknownError",
      data: {
        message: "Unexpected server error. Check server logs for details.",
        ref: "err_8eb36e0f",
      },
    },
  });
  assert.deepEqual(summarizeOpenCodeFailure({ stdout }), {
    source: "json-error-event",
    sessionId: "ses_unknown",
    errorName: "UnknownError",
    errorCode: null,
    errorRef: "err_8eb36e0f",
    errorMessage: "Unexpected server error. Check server logs for details.",
    providerId: null,
    modelId: null,
    serverLogExcerpt: null,
  });
});

test("OpenCode server log correlation emits only bounded redacted errorRef evidence", async () => {
  const { summarizeOpenCodeFailure } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const stdout = JSON.stringify({
    type: "error",
    sessionID: "ses_unknown",
    error: {
      name: "UnknownError",
      data: {
        message: "Unexpected server error. Check server logs for details.",
        ref: "err_4a05fee2",
      },
    },
  });
  const stderr = [
    'timestamp=2026-09-22T23:43:56Z level=ERROR run=test message=failed ref=err_other error="ignore me"',
    'timestamp=2026-09-22T23:43:56Z level=ERROR run=test message=failed ref=err_4a05fee2 error="TypeError: provider exploded Bearer sk-super-secret-12345678" prompt="private user prompt"',
  ].join("\n");
  const summary = summarizeOpenCodeFailure({ stdout, stderr });
  assert.equal(summary.errorRef, "err_4a05fee2");
  assert.match(summary.serverLogExcerpt, /TypeError: provider exploded/u);
  assert.match(summary.serverLogExcerpt, /Bearer \[REDACTED\]/u);
  assert.match(summary.serverLogExcerpt, /prompt=\[REDACTED\]/u);
  assert.doesNotMatch(summary.serverLogExcerpt, /super-secret|private user prompt/u);
  assert.doesNotMatch(summary.serverLogExcerpt, /ignore me/u);
});

test("qualification waitFor propagates terminal predicate errors without converting them to timeout", async () => {
  const { waitFor } = await import("../../scripts/qualification/lib/util.mjs");
  const terminal = new Error("terminal-qualification-hold");
  let attempts = 0;
  await assert.rejects(
    waitFor(() => {
      attempts += 1;
      throw terminal;
    }, {
      timeoutMs: 5_000,
      intervalMs: 1,
      label: "terminal-propagation",
      shouldRetryError: () => false,
    }),
    (error) => error === terminal,
  );
  assert.equal(attempts, 1);
});

test("runtime worker pins an OpenCode build containing the compiled filesystem-cycle fix", () => {
  const dockerfile = source("apps/runtime-worker/Dockerfile");
  assert.match(dockerfile, /opencode-ai@1\.18\.32/u);
  assert.doesNotMatch(dockerfile, /opencode-ai@1\.18\.26/u);
});

test("OpenCode attempt-state resolver gives Runtime-projected state root precedence over manifest adjacency", async () => {
  const { resolveOpenCodeAttemptStateRoot } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const manifestPath = resolve(root, "synthetic-runtime", "task", "agent-input-manifest.json");
  const runtimeRoot = resolve(root, "synthetic-runtime-owned-state");

  const projected = resolveOpenCodeAttemptStateRoot({
    manifestPath,
    attempt: 2,
    env: { AGENT_HARNESS_AGENT_EXECUTION_STATE_ROOT: runtimeRoot },
  });
  assert.equal(projected.stateRoot, resolve(runtimeRoot, "attempt-2"));
  assert.equal(projected.authority, "runtime-projected-ephemeral-home");

  const legacy = resolveOpenCodeAttemptStateRoot({ manifestPath, attempt: 2, env: {} });
  assert.equal(
    legacy.stateRoot,
    resolve(root, "synthetic-runtime", "task", "opencode-attempt-state", "attempt-2"),
  );
  assert.equal(legacy.authority, "manifest-adjacent-legacy-fallback");
});

test("restricted model OpenCode state is rooted in Runtime-owned ephemeral HOME, never the root-owned task directory", () => {
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  const executor = source("scripts/internal/opencode-task-executor.mjs");

  assert.match(worker, /command\.env_remove\("AGENT_HARNESS_AGENT_EXECUTION_STATE_ROOT"\)/u);
  assert.match(worker, /command\.env_remove\("XDG_DATA_HOME"\)/u);
  assert.match(worker, /command\.env_remove\("XDG_STATE_HOME"\)/u);
  assert.match(
    worker,
    /"AGENT_HARNESS_AGENT_EXECUTION_STATE_ROOT",[\s\S]*home\.join\("runtime-state"\)/u,
  );
  assert.match(worker, /model_agent_home_cleanup_after_execution_failed/u);

  assert.match(executor, /AGENT_HARNESS_AGENT_EXECUTION_STATE_ROOT/u);
  assert.match(executor, /runtime-projected-ephemeral-home/u);
  assert.match(executor, /manifest-adjacent-legacy-fallback/u);
  assert.match(executor, /resolveOpenCodeAttemptStateRoot/u);
  assert.match(executor, /XDG_CONFIG_HOME: configHome/u);
  assert.match(executor, /XDG_CACHE_HOME: cacheHome/u);
  assert.match(executor, /OPENCODE_PURE: "1"/u);
  assert.match(executor, /OPENCODE_DISABLE_PROJECT_CONFIG: "1"/u);
  assert.match(executor, /delete isolatedEnv\.OPENCODE_CONFIG/u);
  assert.match(executor, /delete isolatedEnv\.OPENCODE_CONFIG_DIR/u);
  assert.match(executor, /"--pure"/u);
  assert.match(executor, /"--print-logs"/u);
  assert.match(executor, /"--log-level", "ERROR"/u);
  assert.match(executor, /onStderr: \(\) => \{\}/u);
  assert.doesNotMatch(executor, /onStderr: \(chunk\) => process\.stderr\.write\(chunk\)/u);
  assert.doesNotMatch(
    executor,
    /const stateRoot = join\(dirname\(resolve\(String\(manifestPath\)\)\), "opencode-attempt-state"/u,
  );
});

test("runtime-worker image packages the full JS dependency closure required by technical plan synthesis", () => {
  const dockerfile = source("apps/runtime-worker/Dockerfile");
  assert.match(dockerfile, /COPY packages \.\/packages/u);
  assert.match(
    dockerfile,
    /RUN node --input-type=module -e "await import\('\.\/\.agents\/runtime\/technical-plan-synthesis\.mjs'\)"/u,
  );

  const synthesis = source(".agents/runtime/technical-plan-synthesis.mjs");
  assert.match(synthesis, /packages\/project-adapters\/src\/command-spec-catalog\.mjs/u);
  const catalog = source("packages/project-adapters/src/command-spec-catalog.mjs");
  assert.match(catalog, /\.\/trusted-config\.mjs/u);
  const trustedConfig = source("packages/project-adapters/src/trusted-config.mjs");
  assert.match(trustedConfig, /packages\/source-identity|\.\.\/\.\.\/source-identity\/src\/git-snapshot\.mjs/u);
  assert.match(trustedConfig, /\.\.\/\.\.\/harness-contracts\/src\//u);
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

test("every model-controlled executor child is privilege-dropped and cannot inherit Runtime infrastructure credentials", () => {
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  assert.match(worker, /command\.env_remove\(sensitive\)/);
  for (const key of [
    "AGENT_POSTGRES_URL",
    "DATABASE_URL",
    "AGENT_HARNESS_RUNTIME_RABBITMQ_URL",
    "AGENT_HARNESS_DOCKER_GATEWAY_URL",
    "AGENT_HARNESS_DOCKER_GATEWAY_HMAC_KEY",
    "AGENT_HARNESS_OPENCODE_CONTINUATION_URL",
    "AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME",
    "AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD",
    "OPENCODE_SERVER_PASSWORD",
    "CONTEXT_ENGINE_PROJECT_MEMORY_POSTGRES_URL",
    "CONTEXT_EXACT_REDIS_URL",
    "CONTEXT_SEMANTIC_REDIS_URL",
  ]) {
    assert.ok(worker.includes(`"${key}"`));
  }
  assert.match(worker, /descriptor\.execution_mode == "agent"/);
  assert.match(worker, /model_agent_requires_copy_workspace/);
  assert.match(worker, /let isolated_process_group = descriptor\.execution_mode == "agent"/);
});

test("typed model child can reach Context Engine but not private control-plane networks", () => {
  const dockerfile = source("apps/runtime-worker/Dockerfile");
  const entrypoint = source("apps/runtime-worker/entrypoint.sh");
  const compose = source("compose.yaml");

  assert.match(dockerfile, /iptables/);
  assert.match(dockerfile, /util-linux/);
  assert.match(compose, /agent-runtime-worker:[\s\S]*cap_add: \[NET_ADMIN\]/);

  assert.match(entrypoint, /--uid-owner 10001/);
  assert.match(entrypoint, /context-engine/);
  assert.match(entrypoint, /--dport 8789 -j RETURN/);
  for (const cidr of [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
  ]) {
    assert.ok(entrypoint.includes(cidr));
  }
  assert.match(entrypoint, /--bounding-set=-net_admin/);
  assert.match(entrypoint, /--inh-caps=-net_admin/);
  assert.match(entrypoint, /--ambient-caps=-net_admin/);
  assert.match(entrypoint, /--no-new-privs/);

  const contextAllow = entrypoint.indexOf('--dport 8789 -j RETURN');
  const privateReject = entrypoint.indexOf('10.0.0.0/8');
  const workerExec = entrypoint.indexOf('/usr/local/bin/agentic-harness-worker');
  assert.ok(contextAllow >= 0 && privateReject > contextAllow && workerExec > privateReject);
});

test("Docker behavior gateway ships a CLI new enough for volume-subpath isolation", () => {
  const dockerfile = source("apps/docker-gateway/Dockerfile");
  assert.match(dockerfile, /FROM docker:27\.5\.1-cli AS docker-cli/);
  assert.match(dockerfile, /COPY --from=docker-cli \/usr\/local\/bin\/docker \/usr\/local\/bin\/docker/);
  assert.doesNotMatch(dockerfile, /apt-get install[^\n]*docker\.io/);
});

test("Docker gateway handles PostgreSQL idle-pool errors without process termination", () => {
  const fenceStore = source("apps/docker-gateway/fence-store.mjs");
  assert.match(fenceStore, /ownedPool\.on\('error', \(\) => \{\}\)/u);
  assert.match(fenceStore, /docker_gateway_capability_store_unavailable/u);
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


test("model agent tasks drop child privileges and typed tasks kill the isolated process group before minting gateway capability", () => {
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  const dockerfile = source("apps/runtime-worker/Dockerfile");

  assert.match(dockerfile, /agentexec:x:10001:10001/);
  assert.match(worker, /BEHAVIOR_AGENT_UID: u32 = 10_001/);
  assert.match(worker, /command\.uid\(BEHAVIOR_AGENT_UID\)/);
  assert.match(worker, /command\.gid\(BEHAVIOR_AGENT_GID\)/);
  assert.match(worker, /command\.process_group\(0\)/);
  const runtimeContracts = source(".agents/runtime/event-driven-contracts.mjs");
  assert.match(worker, /prepare_restricted_model_agent/);
  assert.match(worker, /model_agent_output_directory_invalid/);
  assert.match(worker, /model_agent_runtime_output_directory_mismatch/);
  assert.match(worker, /model_agent_output_chown_failed/);
  assert.match(worker, /model_agent_output_chmod_failed/);
  assert.match(worker, /descriptor\.handoff_path/);
  assert.match(worker, /descriptor\.log_path/);
  assert.match(worker, /descriptor\.result_path/);
  assert.match(worker, /descriptor\.change_set_path/);
  assert.match(runtimeContracts, /agent-output-attempt-\$\{attempt\}/);
  assert.match(runtimeContracts, /handoffPath: join\(agentOutputDirectory,/);
  assert.match(worker, /terminate_isolated_process_group\(pid\)\.await/);

  const recursiveWorkspaceChown = worker.indexOf('args(["-R", &format!("{BEHAVIOR_AGENT_UID}:{BEHAVIOR_AGENT_GID}")])');
  const scopedOutputDirChown = worker.indexOf("let output_dir_chown = Command::new(\"chown\")", recursiveWorkspaceChown);
  const scopedOutputDirChmod = worker.indexOf("let output_dir_chmod = Command::new(\"chmod\")", scopedOutputDirChown);
  const drain = worker.indexOf('drain_executor_output(stdout_task, "stdout", claimed, client).await');
  const terminate = worker.indexOf("terminate_isolated_process_group(pid).await", drain);
  const homeCleanup = worker.indexOf("model_agent_home_cleanup_after_execution_failed", terminate);
  const capability = worker.indexOf("run_behavior_gateway_under_lease", drain);
  assert.ok(recursiveWorkspaceChown >= 0 && scopedOutputDirChown > recursiveWorkspaceChown && scopedOutputDirChmod > scopedOutputDirChown);
  assert.ok(drain >= 0 && terminate > drain && homeCleanup > terminate && capability > homeCleanup);
});

test("revoked behavior execution repeatedly reaps its fence-bound Docker container", () => {
  const executor = source("packages/project-adapters/src/behavior-executor-v2.mjs");
  assert.match(executor, /verifyNamedContainerRemovedAfterAbort/);
  assert.match(executor, /for \(const delayMs of \[0, 100, 400, 1_000\]\)/);
  assert.match(executor, /'rm', '-f', containerName/);
  assert.match(executor, /if \(aborted \|\| timedOut \|\| outputLimit\)/);
  assert.match(executor, /await verifyNamedContainerRemovedAfterAbort/);
});
