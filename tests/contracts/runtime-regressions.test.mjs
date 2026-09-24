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

test("compiled execution-plan schema carries Runtime command authority fields", () => {
  const schema = JSON.parse(source(".agents/schemas/execution-plan.schema.json"));
  const taskProperties = schema.properties.tasks.items.properties;
  assert.ok(taskProperties.validationCommandIds);
  assert.ok(taskProperties.commandSpecIds);
  assert.ok(taskProperties.commandAuthority);
  assert.equal(taskProperties.commandAuthority.anyOf[1].properties.schemaVersion.const, "command-authority/v1");
  assert.equal(taskProperties.validationCommandIds.items.pattern, "^vcmd:sha256:[a-f0-9]{64}$");
});

test("task execution fence accepts Rust Chrono RFC3339 and canonicalizes at the JS boundary", async () => {
  const {
    validateTaskExecutionFence,
    validateActiveTaskExecutionFence,
  } = await import("../../packages/harness-contracts/src/execution-fence.mjs");

  const fence = {
    schemaVersion: "task-execution-fence/v1",
    runId: "run-rfc3339",
    taskId: "task-rfc3339",
    attempt: 1,
    dispatchGeneration: 1,
    fencingToken: 1,
    leaseOwner: "agentic-harness-worker",
    leaseExpiresAt: "2099-01-01T00:00:00.123456789+00:00",
    observedAt: "2026-09-24T00:00:00+00:00",
  };

  const checked = validateTaskExecutionFence(fence);
  assert.equal(checked.leaseExpiresAt, "2099-01-01T00:00:00.123Z");
  assert.equal(checked.observedAt, "2026-09-24T00:00:00.000Z");
  assert.doesNotThrow(() =>
    validateActiveTaskExecutionFence(fence, {
      now: new Date("2026-09-24T00:00:00.500Z"),
    }),
  );
  assert.throws(
    () => validateTaskExecutionFence({ ...fence, observedAt: "2026-09-24" }),
    /task_execution_fence_invalid/u,
  );
});

test("behavior gateway completion event preserves admission reasons", () => {
  const worker = source("apps/runtime-worker/src/agent_runtime.rs");
  const gateway = source("apps/runtime-worker/src/behavior_gateway.rs");

  assert.match(gateway, /pub fn admission_reasons\(&self\) -> Vec<String>/u);
  assert.match(gateway, /task-execution-fence-invalid/u);
  assert.match(worker, /let admission_reasons = result\.admission_reasons\(\)/u);
  assert.match(worker, /"admissionReasons": admission_reasons/u);
});

test("Runtime event wire prefix is identical across JS emitters and Rust consumer", () => {
  const opencodeExecutor = source("scripts/internal/opencode-task-executor.mjs");
  const legacyExecutor = source(".agents/runtime/executor.mjs");
  const rustWorker = source("apps/runtime-worker/src/agent_runtime.rs");
  assert.match(
    opencodeExecutor,
    /const RUNTIME_EVENT_PREFIX = "@@agentic-harness-runtime-event ";/u,
  );
  assert.match(
    legacyExecutor,
    /const RUNTIME_EVENT_PREFIX = "@@agentic-harness-runtime-event ";/u,
  );
  assert.match(
    rustWorker,
    /const PREFIX: &str = "@@agentic-harness-runtime-event ";/u,
  );
  assert.doesNotMatch(
    rustWorker,
    /const PREFIX: &str = "@@agent-harness-runtime-event ";/u,
  );
});

test("OpenCode model-catalog and failure runtime events are persisted by the semantic finalizer", () => {
  const finalizer = source(".agents/runtime/event-driven-finalizer.mjs");
  assert.match(finalizer, /"opencode\.model_catalog"/u);
  assert.match(finalizer, /"opencode\.failure"/u);
  assert.match(finalizer, /BUFFERED_PERFORMANCE_EVENT_TYPES/u);
});

test("OpenCode selected-model preflight avoids refresh on active-provider hit", async () => {
  const { ensureOpenCodeModelAvailable } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const calls = [];
  const result = await ensureOpenCodeModelAvailable({
    model: "openai/gpt-5.6-luna",
    workspace: root,
    env: {},
    run: async (command, args) => {
      calls.push({ command, args });
      if (args.includes("auth")) {
        return {
          status: 0,
          timedOut: false,
          stdout: "OpenAI oauth\n1 credentials\n",
          stderr: "",
        };
      }
      return {
        status: 0,
        timedOut: false,
        stdout: "openai/gpt-5.4\nopenai/gpt-5.6-luna\n",
        stderr: "",
      };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.refreshAttempted, false);
  assert.equal(result.source, "active-provider-cache");
  assert.equal(result.auth.providerCredentialObserved, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["--pure", "auth", "list"]);
  assert.deepEqual(calls[1].args, ["--pure", "models", "openai"]);
});

test("OpenCode selected-model preflight refreshes then revalidates in a fresh provider process", async () => {
  const { ensureOpenCodeModelAvailable } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const calls = [];
  const result = await ensureOpenCodeModelAvailable({
    model: "openai/gpt-5.6-luna",
    workspace: root,
    env: {},
    runtimeConfigContent: JSON.stringify({ default_agent: "product-owner" }),
    run: async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (args.includes("auth")) {
        return {
          status: 0,
          timedOut: false,
          stdout: "OpenAI oauth\n1 credentials\n",
          stderr: "",
        };
      }
      if (args.includes("--refresh")) {
        return {
          // OpenCode can refresh models.json and still exit nonzero because the
          // provider projection inside this same process remains stale.
          status: 1,
          timedOut: false,
          stdout: "Models cache refreshed\n",
          stderr: "Provider not found: openai\n",
        };
      }
      const modelProbeIndex = calls.filter((call) => call.args.includes("models")).length;
      return {
        status: modelProbeIndex === 1 ? 1 : 0,
        timedOut: false,
        stdout: modelProbeIndex === 1
          ? ""
          : "openai/gpt-5.4\nopenai/gpt-5.6-luna\n",
        stderr: modelProbeIndex === 1 ? "Provider not found: openai\n" : "",
      };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.refreshAttempted, true);
  assert.equal(result.source, "models-dev-refresh-reloaded");
  assert.equal(result.auth.providerCredentialObserved, true);
  assert.equal(result.refresh.status, 1);
  assert.equal(result.revalidation.status, 0);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].args, ["--pure", "auth", "list"]);
  assert.deepEqual(calls[1].args, ["--pure", "models", "openai"]);
  assert.deepEqual(calls[2].args, ["--pure", "models", "openai", "--refresh"]);
  assert.deepEqual(calls[3].args, ["--pure", "models", "openai"]);
  assert.equal(calls[2].env.OPENCODE_CONFIG_CONTENT, JSON.stringify({ default_agent: "product-owner" }));
  assert.match(result.refresh.diagnostic, /Provider not found: openai/u);
});

test("OpenCode selected-model preflight short-circuits immediately when OAuth is absent", async () => {
  const { ensureOpenCodeModelAvailable } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const calls = [];
  const result = await ensureOpenCodeModelAvailable({
    model: "openai/gpt-5.6-luna",
    workspace: root,
    env: {},
    run: async (_command, args) => {
      calls.push(args);
      return {
        status: 0,
        timedOut: false,
        stdout: "0 credentials\n",
        stderr: "",
      };
    },
  });
  assert.equal(result.available, false);
  assert.equal(result.refreshAttempted, false);
  assert.equal(result.source, "provider-credential-unavailable");
  assert.equal(result.auth.providerCredentialObserved, false);
  assert.equal(result.local, null);
  assert.equal(result.refresh, null);
  assert.equal(result.revalidation, null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["--pure", "auth", "list"]);
});

test("OpenCode selected-model preflight fails closed after fresh-process model revalidation", async () => {
  const { ensureOpenCodeModelAvailable } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const calls = [];
  const result = await ensureOpenCodeModelAvailable({
    model: "openai/gpt-5.6-luna",
    workspace: root,
    env: {},
    run: async (_command, args) => {
      calls.push(args);
      if (args.includes("auth")) {
        return {
          status: 0,
          timedOut: false,
          stdout: "OpenAI oauth\n1 credentials\n",
          stderr: "",
        };
      }
      return {
        status: 1,
        timedOut: false,
        stdout: args.includes("--refresh") ? "Models cache refreshed\n" : "",
        stderr: "Provider not found: openai\n",
      };
    },
  });
  assert.equal(result.available, false);
  assert.equal(result.refreshAttempted, true);
  assert.equal(result.source, "unavailable-after-refresh-reload");
  assert.equal(result.auth.providerCredentialObserved, true);
  assert.equal(result.revalidation.status, 1);
  assert.match(result.local.diagnostic, /Provider not found: openai/u);
  assert.match(result.revalidation.diagnostic, /Provider not found: openai/u);
  assert.equal(calls.length, 4);
});

test("OpenCode provider auth/model misses are deterministic non-retryable failures", async () => {
  const { classifyValidationFailure } = await import("../../.agents/runtime/executor.mjs");
  const cases = [
    ["Error: opencode_model_unavailable_after_refresh:openai/gpt-5.6-luna", "opencode_provider_model_not_found"],
    ["Error: opencode_model_unavailable_after_refresh_reload:openai/gpt-5.6-luna", "opencode_provider_model_not_found"],
    ["ProviderModelNotFoundError: Model not found: openai/gpt-5.6-luna", "opencode_provider_model_not_found"],
    ["Error: opencode_provider_credential_not_observed:openai", "opencode_provider_auth_not_observed"],
    ['@@agentic-harness-runtime-event {"type":"opencode.failure","payload":{"errorName":"ProviderAuthError"}}', "opencode_provider_auth_not_observed"],
  ];
  for (const [stderr, expectedCode] of cases) {
    const failure = classifyValidationFailure({
      result: {
        status: 1,
        timedOut: false,
        softTimedOut: false,
        stalled: false,
        stderr,
        stdout: "",
        error: null,
      },
      preTeardownHealth: null,
      dockerBlocked: null,
      lifecycleUsed: false,
    });
    assert.equal(failure.code, expectedCode);
    assert.equal(failure.retryable, false);
    assert.equal(failure.category, "provider");
  }
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

test("qualification projects only OpenAI OAuth into the runtime worker and proves it in R-4", () => {
  const qualification = source("scripts/qualification/standalone-v1.mjs");

  assert.match(qualification, /prepareQualificationOpenCodeAuthProjection/u);
  assert.match(qualification, /qualification_opencode_auth_source_missing/u);
  assert.match(qualification, /qualification_openai_oauth_credential_invalid/u);
  assert.match(qualification, /JSON\.stringify\(\{ openai: credential \}, null, 2\)/u);
  assert.match(qualification, /mode: 0o600/u);
  assert.match(qualification, /mkdtempSync\(join\(tmpdir\(\), "agentic-harness-opencode-auth-"/u);
  assert.match(qualification, /state\.opencodeAuthProjection\.directory/u);
  assert.match(qualification, /rmSync\(state\.opencodeAuthProjection\.directory/u);
  assert.match(
    qualification,
    /AGENT_HARNESS_OPENCODE_AUTH_HOST_FILE: opencodeAuthProjection\.path/u,
  );
  assert.match(
    qualification,
    /"exec", "-T", "agent-runtime-worker", "opencode", "--pure", "auth", "list"/u,
  );
  assert.match(qualification, /runtime_worker_openai_oauth_credential_missing/u);
  assert.match(qualification, /qualificationOpenCodeAuthProjection/u);
});

test("runtime worker pins and qualifies the exact OpenCode build", () => {
  const dockerfile = source("apps/runtime-worker/Dockerfile");
  const qualification = source("scripts/qualification/standalone-v1.mjs");
  assert.match(dockerfile, /opencode-ai@1\.18\.32/u);
  assert.doesNotMatch(dockerfile, /opencode-ai@1\.18\.26/u);
  assert.match(qualification, /QUALIFICATION_RUNTIME_WORKER_OPENCODE_VERSION = "1\.18\.32"/u);
  assert.match(
    qualification,
    /"exec", "-T", "agent-runtime-worker", "opencode", "--version"[\s\S]*r4-worker-opencode-version/u,
  );
  assert.match(qualification, /runtime_worker_opencode_version_mismatch/u);
  assert.match(qualification, /workerOpenCodeVersion/u);
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
  assert.match(executor, /delete isolatedEnv\.OPENCODE_DISABLE_MODELS_FETCH/u);
  assert.match(executor, /delete isolatedEnv\.OPENCODE_MODELS_PATH/u);
  assert.match(executor, /delete isolatedEnv\.OPENCODE_MODELS_URL/u);
  assert.match(executor, /delete isolatedEnv\.OPENCODE_DISABLE_DEFAULT_PLUGINS/u);
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

test("restricted OpenCode provider preflight owns auth, refresh and fresh-process revalidation", () => {
  const executor = source("scripts/internal/opencode-task-executor.mjs");

  assert.match(executor, /ensureOpenCodeModelAvailable/u);
  assert.match(executor, /"--pure", "auth", "list"/u);
  assert.match(executor, /const refresh = await invokeModels\(true\)/u);
  assert.match(executor, /const revalidation = await invokeModels\(false\)/u);
  assert.match(executor, /"models-dev-refresh-reloaded"/u);
  assert.match(executor, /"unavailable-after-refresh-reload"/u);
  assert.match(executor, /providerCredentialObserved/u);
  assert.match(executor, /"opencode\.model_catalog"/u);
  assert.match(executor, /opencode_provider_credential_not_observed/u);
  assert.match(executor, /opencode_model_unavailable_after_refresh_reload/u);
});

test("event-driven scheduler does not create semantic progress from no-op peak bookkeeping", () => {
  const reconciler = source(".agents/runtime/event-driven-reconciler.mjs");
  assert.match(reconciler, /const currentPeak = Number\(\(await store\.getRun\(plan\.runId\)\)\?\.peak_parallel \?\? 0\)/u);
  assert.match(reconciler, /if \(peak > currentPeak\) await store\.updateRun\(plan\.runId, \{ peak_parallel: peak \}\)/u);
  assert.doesNotMatch(reconciler, /if \(peak > 0\) await store\.updateRun\(plan\.runId, \{ peak_parallel: peak \}\)/u);
  assert.match(reconciler, /scheduler_ready_task_missing_plan/u);
});

test("runtime model child cannot mutate the bind-mounted source root from bootstrap governance", () => {
  const executor = source("scripts/internal/opencode-task-executor.mjs");

  assert.match(executor, /AGENT_HARNESS_PROJECT_ROOT: workspace/u);
  assert.match(executor, /AGENT_HARNESS_AGENT_WORKSPACE: workspace/u);
  assert.match(executor, /projectRootAuthority: "execution-workspace"/u);
  assert.match(executor, /external_directory: "deny"/u);
  assert.match(executor, /normalizedStage === "product-discovery"/u);
  assert.match(executor, /normalizedStage === "technical-refinement"/u);
  assert.match(executor, /isBootstrapReviewStage\(normalizedStage\)/u);
  assert.match(executor, /\.\.\.\(governanceStage \? \{ bash: "deny" \} : \{\}\)/u);
  assert.doesNotMatch(
    executor,
    /permission:\s*\{\s*question:\s*"deny"\s*\}/u,
  );
});

test("bootstrap governance loses shell authority while implementation keeps workspace shell", async () => {
  const { buildHeadlessRuntimeOverride } = await import("../../scripts/internal/opencode-task-executor.mjs");
  const topology = {
    orchestrationRole: "specialist",
    interactiveMode: "subagent",
    sessionRole: "primary",
  };
  const product = buildHeadlessRuntimeOverride({
    agentId: "product-owner",
    stepsLimit: 100,
    stage: "product-discovery",
    executionTopology: topology,
    contextEngineUrl: null,
  });
  const implementation = buildHeadlessRuntimeOverride({
    agentId: "backend-specialist",
    stepsLimit: 100,
    stage: "implementation",
    executionTopology: topology,
    contextEngineUrl: null,
  });

  assert.equal(product.agent["product-owner"].permission.external_directory, "deny");
  assert.equal(product.agent["product-owner"].permission.bash, "deny");
  assert.equal(implementation.agent["backend-specialist"].permission.external_directory, "deny");
  assert.equal(Object.hasOwn(implementation.agent["backend-specialist"].permission, "bash"), false);
});

test("Technical Plan synthesis uses copy workspace for validation and repository root for committed command authority", () => {
  const executor = source("scripts/internal/opencode-task-executor.mjs");
  const synthesis = source(".agents/runtime/technical-plan-synthesis.mjs");

  assert.match(
    executor,
    /synthesizeMissingImplementationPlan\(\{[\s\S]*?workspace,[\s\S]*?committedSourceRoot: repositoryRoot,/u,
  );
  assert.match(
    executor,
    /repairImplementationPlanFromReview\(\{[\s\S]*?workspace,[\s\S]*?committedSourceRoot: repositoryRoot,/u,
  );
  assert.match(
    synthesis,
    /buildValidationCommandCatalog\(\{[\s\S]*?workspace,[\s\S]*?committedSourceRoot = workspace,/u,
  );
  assert.match(synthesis, /buildCommittedCommandSpecCatalog\(committedSourceRoot\)/u);
  assert.doesNotMatch(
    synthesis,
    /const commandSpecContext = buildCommittedCommandSpecCatalog\(workspace\)/u,
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
