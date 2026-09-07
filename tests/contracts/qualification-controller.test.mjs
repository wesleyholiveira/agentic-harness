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


test("R-4 proves Context Engine and Runtime worker share the same execution-workspace volume authority", () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  assert.match(controller, /const workspaceDestination = "\/workspace\/agent-workspaces"/);
  assert.match(controller, /runtime_workspace_root_authority_mismatch/);
  assert.match(controller, /runtime_workspace_shared_volume_missing/);
  assert.match(controller, /runtime_workspace_volume_not_shared/);
  assert.match(controller, /contextEngineWorkspaceMount\.Source !== workerWorkspaceMount\.Source/);
  assert.match(controller, /workspaceAuthority/);
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


test("qualification Runtime observations preserve reconcile failure code and message", () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  const driver = readFileSync(resolve(root, ".agents/runtime/runtime-driver.mjs"), "utf8");
  assert.match(controller, /payload_json::jsonb->>'message'/);
  assert.match(controller, /'message', NULLIF\(COALESCE\(payload_json::jsonb->>'message',''\),''\)/);
  assert.match(driver, /"runtime\.reconcile_failed", \{[\s\S]*?code:[\s\S]*?message:/);
});

test("R-8 continuation wait is progress-aware and never expires before the Runtime assistant-completion budget", async () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  const rustConfig = readFileSync(resolve(root, "apps/runtime-worker/src/config.rs"), "utf8");
  const {
    DEFAULT_CONTINUATION_COMPLETION_TIMEOUT_MS,
    evaluateContinuationObservation,
  } = await import("../../scripts/qualification/lib/continuation-watchdog.mjs");

  assert.equal(DEFAULT_CONTINUATION_COMPLETION_TIMEOUT_MS, 900_000);
  assert.match(rustConfig, /AGENT_HARNESS_OPENCODE_CONTINUATION_COMPLETION_TIMEOUT_MS[\s\S]*?900_000_u64/);
  assert.match(controller, /continuationCompletionTimeoutMs\(\)/);
  assert.match(controller, /evaluateContinuationObservation/);
  assert.match(controller, /formatContinuationProgress/);
  assert.match(controller, /continuation_progress_aware_watch_safety_ceiling/);
  assert.match(controller, /waitForContinuationObserved\(runId, sessionId, \{ gate: "R-8" \}\)/);
  assert.match(controller, /waitForContinuationObserved\(runId, sessionId, \{ gate: "R-10" \}\)/);
  assert.doesNotMatch(controller, /r8-continuation-accepted-observed/);
  const r8Section = controller.slice(controller.indexOf("async function r8()"), controller.indexOf("async function r9()"));
  assert.doesNotMatch(r8Section, /timeoutMs:\s*10\s*\*\s*60_000/);

  const dispatchStartedAt = "2026-09-06T22:07:50.000Z";
  const nowMs = Date.parse("2026-09-06T22:17:56.000Z");
  const observation = {
    delivery: {
      deliveryId: "delivery-1",
      effectKey: "sha256:effect",
      messageId: "msg_wake",
      promptText: "Agentic Harness Runtime V2 continuation event.\n\nrunId: run-1",
      generation: 1,
      status: "accepted",
      acceptedAt: "2026-09-06T22:07:52.000Z",
      observedAt: null,
      dispatchStartedAt,
      createdAt: "2026-09-06T22:07:50.000Z",
      attempts: 1,
    },
    continuation: { status: "wake_pending" },
    sessionStatus: "busy",
    wakeCount: 1,
    assistant: { state: "pending", messageId: "msg-assistant", count: 1, error: null },
  };
  const result = evaluateContinuationObservation(observation, {
    nowMs,
    completionTimeoutMs: DEFAULT_CONTINUATION_COMPLETION_TIMEOUT_MS,
  });
  assert.equal(result.terminal, null);
  assert.equal(result.violation, null);
});

test("R-8 continuation observation is JSON-framed so multiline prompt text cannot corrupt delivery columns", () => {
  const controller = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  const section = controller.slice(
    controller.indexOf("async function continuationObservation(runId, sessionId)"),
    controller.indexOf("function toolNames", controller.indexOf("async function continuationObservation(runId, sessionId)")),
  );
  assert.match(section, /const raw = sqlScalar\(`SELECT json_build_object\(/);
  assert.match(section, /'promptText', d\.prompt_text/);
  assert.match(section, /snapshot = JSON\.parse\(raw\)/);
  assert.doesNotMatch(section, /sqlRows\(/);
  assert.match(controller, /continuation_delivered_event_identity_mismatch/);
  const r8Section = controller.slice(controller.indexOf("async function r8()"), controller.indexOf("async function r9()"));
  assert.doesNotMatch(r8Section, /assistant\?\.count !== 1/);
});

test("R-8 assistant audit mirrors Rust latest-child semantics for multi-step OpenCode turns", async () => {
  const { summarizeContinuationAssistant } = await import("../../scripts/qualification/lib/continuation-watchdog.mjs");
  const wakeId = "msg_wake";
  const history = Array.from({ length: 7 }, (_, index) => ({
    info: {
      id: `msg_assistant_${index + 1}`,
      role: "assistant",
      parentID: wakeId,
      time: {
        created: index + 1,
        ...(index === 6 ? { completed: index + 10 } : {}),
      },
      ...(index === 6 ? { finish: "stop" } : {}),
    },
    parts: [],
  }));
  history.push({ info: { id: "other", role: "assistant", parentID: "different", time: { created: 99, completed: 100 }, finish: "stop" }, parts: [] });

  const summary = summarizeContinuationAssistant(history, wakeId);
  assert.equal(summary.count, 7);
  assert.equal(summary.state, "completed");
  assert.equal(summary.messageId, "msg_assistant_7");
  assert.equal(summary.error, null);
  assert.deepEqual(summary.toolCalls, []);
  assert.deepEqual(summary.activeToolCalls, []);
});



test("R-8 continuation diagnostics expose pending tool calls without trusting tool output", async () => {
  const { summarizeContinuationAssistant, formatContinuationProgress } = await import("../../scripts/qualification/lib/continuation-watchdog.mjs");
  const summary = summarizeContinuationAssistant([{
    info: { id: "msg_assistant_1", role: "assistant", parentID: "msg_wake", time: { created: 1000 } },
    parts: [{
      type: "tool",
      callID: "call_1",
      tool: "agent_summary",
      state: { status: "running", input: { runId: "run-1" }, time: { start: 1200 } },
    }],
  }], "msg_wake");
  assert.equal(summary.state, "pending");
  assert.equal(summary.toolCalls.length, 1);
  assert.deepEqual(summary.activeToolCalls.map((call) => [call.tool, call.status]), [["agent_summary", "running"]]);
  assert.equal("input" in summary.toolCalls[0], false);
  assert.match(formatContinuationProgress({ delivery: { status: "accepted", attempts: 1 }, assistant: summary }), /tool=agent_summary:running/);
});

test("Durable Continuation does not treat completed OpenCode tool-call steps as terminal assistant proof", async () => {
  const rust = readFileSync(resolve(root, "apps/runtime-worker/src/agent_continuation.rs"), "utf8");
  assert.match(rust, /fn assistant_finish_requires_followup\(finish: &str\)/);
  assert.match(rust, /"tool-calls" \| "tool_calls" \| "tool-use" \| "tool_use"/);
  assert.match(rust, /completed_tool_call_assistant_step_is_not_terminal_continuation_proof/);
  assert.match(rust, /latest_tool_call_step_keeps_continuation_pending_after_older_completed_child/);

  const { summarizeContinuationAssistant } = await import("../../scripts/qualification/lib/continuation-watchdog.mjs");
  const wakeId = "msg_wake";
  const toolStep = summarizeContinuationAssistant([{
    info: {
      id: "msg_assistant_tool",
      role: "assistant",
      parentID: wakeId,
      time: { created: 1000, completed: 2000 },
      finish: "tool-calls",
    },
    parts: [],
  }], wakeId);
  assert.equal(toolStep.state, "pending");
  assert.equal(toolStep.finish, "tool-calls");
  assert.equal(toolStep.completedAt, 2000);

  const finalStep = summarizeContinuationAssistant([{
    info: {
      id: "msg_assistant_final",
      role: "assistant",
      parentID: wakeId,
      time: { created: 3000, completed: 4000 },
      finish: "stop",
    },
    parts: [],
  }], wakeId);
  assert.equal(finalStep.state, "completed");
  assert.equal(finalStep.finish, "stop");
});

test("R-8 continuation watchdog classifies malformed observer rows as qualification procedure", async () => {
  const { evaluateContinuationObservation } = await import("../../scripts/qualification/lib/continuation-watchdog.mjs");
  const malformed = evaluateContinuationObservation({
    delivery: {
      deliveryId: "delivery-1",
      effectKey: "sha256:effect",
      messageId: "msg_wake",
      promptText: "Agentic Harness Runtime V2 continuation event.",
      // status/generation/attempts/createdAt intentionally absent: this is the exact shape a newline-truncated psql row produced.
    },
    continuation: { currentDeliveryId: null },
  }, { nowMs: Date.parse("2026-09-06T23:10:00Z") });
  assert.equal(malformed.violation?.classification, "QUALIFICATION PROCEDURE");
  assert.equal(malformed.violation?.message, "continuation_observation_shape_invalid");
});

test("R-8 continuation watchdog allows bounded wake-materialization propagation before classifying a stall", async () => {
  const { evaluateContinuationObservation } = await import("../../scripts/qualification/lib/continuation-watchdog.mjs");
  const start = Date.parse("2026-09-06T22:07:50.000Z");
  const pending = evaluateContinuationObservation({ delivery: null, continuation: null }, {
    nowMs: start + 10_000,
    watchStartedAtMs: start,
    completionTimeoutMs: 900_000,
    acceptanceStallTimeoutMs: 900_000,
  });
  assert.equal(pending.violation, null);
  const stalled = evaluateContinuationObservation({ delivery: null, continuation: null }, {
    nowMs: start + 900_001,
    watchStartedAtMs: start,
    completionTimeoutMs: 900_000,
    acceptanceStallTimeoutMs: 900_000,
  });
  assert.equal(stalled.violation?.message, "continuation_delivery_materialization_stalled");
});

test("R-8 continuation watchdog fails only after Runtime completion authority expires or a terminal delivery failure is explicit", async () => {
  const { evaluateContinuationObservation } = await import("../../scripts/qualification/lib/continuation-watchdog.mjs");
  const base = {
    delivery: {
      deliveryId: "delivery-1",
      effectKey: "sha256:effect",
      messageId: "msg_wake",
      promptText: "Agentic Harness Runtime V2 continuation event.\n\nrunId: run-1",
      generation: 1,
      status: "accepted",
      acceptedAt: "2026-09-06T22:07:52.000Z",
      observedAt: null,
      dispatchStartedAt: "2026-09-06T22:07:50.000Z",
      createdAt: "2026-09-06T22:07:50.000Z",
      attempts: 1,
    },
    continuation: { status: "wake_pending" },
    sessionStatus: "idle",
    wakeCount: 1,
    assistant: { state: "pending", messageId: "msg-assistant", count: 1, error: null },
  };

  const expired = evaluateContinuationObservation(base, {
    nowMs: Date.parse("2026-09-06T22:23:21.000Z"),
    completionTimeoutMs: 900_000,
    settleGraceMs: 30_000,
  });
  assert.equal(expired.violation?.message, "continuation_completion_deadline_exceeded_without_runtime_terminal_disposition");

  const ambiguous = evaluateContinuationObservation({
    ...base,
    delivery: { ...base.delivery, status: "ambiguous", lastError: "agent_continuation_assistant_completion_timeout" },
    continuation: { status: "manual_review" },
  }, { nowMs: Date.parse("2026-09-06T22:10:00.000Z") });
  assert.equal(ambiguous.violation?.message, "continuation_delivery_terminal_failure");
});

test("R-8 continuation watchdog accepts only ordered accepted/observed delivery", async () => {
  const { evaluateContinuationObservation } = await import("../../scripts/qualification/lib/continuation-watchdog.mjs");
  const observed = {
    delivery: {
      deliveryId: "delivery-1",
      effectKey: "sha256:effect",
      messageId: "msg_wake",
      promptText: "Agentic Harness Runtime V2 continuation event.\n\nrunId: run-1",
      generation: 1,
      status: "observed",
      acceptedAt: "2026-09-06T22:07:52.000Z",
      observedAt: "2026-09-06T22:08:30.000Z",
      dispatchStartedAt: "2026-09-06T22:07:50.000Z",
      createdAt: "2026-09-06T22:07:50.000Z",
      attempts: 1,
    },
    continuation: { status: "delivered" },
  };
  const good = evaluateContinuationObservation(observed, { nowMs: Date.parse("2026-09-06T22:08:31.000Z") });
  assert.equal(good.violation, null);
  assert.ok(good.terminal);

  const bad = evaluateContinuationObservation({
    ...observed,
    delivery: { ...observed.delivery, acceptedAt: "2026-09-06T22:08:31.000Z" },
  }, { nowMs: Date.parse("2026-09-06T22:08:31.000Z") });
  assert.equal(bad.violation?.message, "continuation_observed_before_accepted");
});
