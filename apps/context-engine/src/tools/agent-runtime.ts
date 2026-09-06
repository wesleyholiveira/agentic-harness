import { z } from "zod";
import type { AgentRuntimeControlAdapter } from "../agent-runtime-control.js";
import type { Visibility } from "../visibility.js";
import { getContextEngineRequestContext } from "../request-context.js";

const RunId = z.string().min(1).max(160);
const TaskId = z.string().min(1).max(240);
const Continuation = z.object({
  sessionId: z.string().min(5).max(160).startsWith("ses_"),
  directory: z.string().min(1).max(2_000).optional(),
  worktree: z.string().min(1).max(2_000).optional(),
  wakeOn: z.array(z.enum(["run.completed", "run.failed", "run.blocked", "run.cancelled"])).min(1).max(4).optional(),
}).strict();

function assertControlCaller(): void {
  const requestContext = getContextEngineRequestContext();
  const agentId = requestContext?.agentId ?? process.env.AGENT_HARNESS_AGENT_ID?.trim() ?? null;
  if (requestContext?.transport === "http" && !agentId) {
    throw new Error("agent_control_caller_identity_required");
  }
  if (agentId && agentId !== "main-orchestrator") {
    throw new Error(`agent_control_requires_main_orchestrator:${agentId}`);
  }
}

async function assertObservationAllowed(
  control: AgentRuntimeControlAdapter,
  toolName: string,
  runId: string | null = null,
): Promise<void> {
  const requestContext = getContextEngineRequestContext();
  const agentId = requestContext?.agentId ?? process.env.AGENT_HARNESS_AGENT_ID?.trim() ?? null;
  if (agentId !== "main-orchestrator") return;
  await control.assertObservationAllowed(toolName, runId, {
    origin: requestContext?.invocationOrigin ?? "unknown",
    sessionId: requestContext?.invocationSessionId ?? null,
    callId: requestContext?.invocationCallId ?? null,
    userMessageId: requestContext?.invocationUserMessageId ?? null,
    provenanceSource: requestContext?.invocationProvenanceSource ?? "missing",
  });
}

function result(data: unknown, status: string, summary: string) {
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const runId = typeof record.runId === "string"
    ? record.runId
    : record.run && typeof record.run === "object" && record.run !== null && "runId" in record.run && typeof record.run.runId === "string"
      ? record.run.runId
      : undefined;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    _meta: { status, summary, ...(runId ? { run_id: runId } : {}) },
  };
}

export function registerAgentRuntimeTools(
  visibility: Visibility,
  control: AgentRuntimeControlAdapter,
): void {
  visibility.registerVisibleTool(
    "agent_start",
    {
      description:
        "Start the Agentic Harness Dynamic DAG V2 asynchronously for a product/runtime workload. The outer Runtime qualification procedure itself is not a workload: requests that try to execute SOURCE/R-* or H-* qualification gates/runbooks inside the DAG are rejected fail-closed before engine.plan with agent_runtime_qualification_meta_run_forbidden. With a durable continuation, the OpenCode server/session target is session-exclusive: if that same target already owns a non-terminal Runtime V2 run, agent_start returns the existing authoritative run with deduplicated=true instead of creating a competing DAG. Terminal Runtime V2 events resume the same session without LLM polling. PostgreSQL owns identity/deduplication and the Rust continuation worker delivers through OpenCode prompt_async. agent_wait remains an observation fallback.",
      inputSchema: {
        request: z.string().min(1).describe("Complete implementation request to execute through the SDD multi-agent DAG"),
        agents: z.array(z.string()).optional().describe("Optional explicit specialist hints; the Technical Lead remains authoritative for implementation ownership"),
        maxParallel: z.number().int().min(1).max(16).optional(),
        maxAttempts: z.number().int().min(1).max(9).optional(),
        contextBudgetBytes: z.number().int().min(10_000).max(2_000_000).optional(),
        continuation: Continuation.optional().describe("OpenCode session context returned by the local runtime-continuation custom tool. The persistent Main Orchestrator MUST supply this for normal delivery workloads so agent_start atomically binds the durable session and returns next=session-resume-event; omission is reserved for non-session/operator control flows. The server URL is configuration-owned and must not be supplied by the LLM"),
      },
    },
    async (args) => {
      assertControlCaller();
      const data = await control.start(args);
      return result(data, "agent-run-started", "AGENT RUN STARTED · Dynamic DAG V2 persisted and executing");
    },
  );

  visibility.registerVisibleTool(
    "agent_bind_continuation",
    {
      description: "Bind an already-started non-terminal Runtime V2 run to the current OpenCode session before the run becomes terminal. One non-terminal run may own a given OpenCode server/session target at a time; a competing bind is rejected. Rebinding after the first wake generation is rejected.",
      inputSchema: { runId: RunId, continuation: Continuation },
    },
    async ({ runId, continuation }) => {
      assertControlCaller();
      return result(
        await control.bindContinuation(runId, continuation),
        "agent-continuation-bound",
        "AGENT CONTINUATION BOUND · terminal event will resume this OpenCode session",
      );
    },
  );

  visibility.registerVisibleTool(
    "context_get_agent_input_artifact",
    {
      description: "Expand one full upstream artifact only when the current AgentInputManifest/v1 authorizes the content-addressed artifactRef. The read is task/attempt/manifest scoped, hash verified, size bounded, and durably receipted.",
      inputSchema: {
        runId: RunId,
        taskId: TaskId,
        attempt: z.number().int().min(1),
        manifestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        artifactRef: z.string().regex(/^artifact:sha256:[a-f0-9]{64}$/),
      },
    },
    async ({ runId, taskId, attempt, manifestFingerprint, artifactRef }) => {
      const requestContext = getContextEngineRequestContext();
      const callerAgentId = requestContext?.agentId ?? process.env.AGENT_HARNESS_AGENT_ID?.trim() ?? null;
      if (!callerAgentId) throw new Error("agent_input_artifact_caller_identity_required");
      return result(
        await control.getAgentInputArtifact({ runId, taskId, attempt, manifestFingerprint, artifactRef, callerAgentId }),
        "agent-input-artifact",
        "AGENT INPUT ARTIFACT · manifest-authorized content-addressed expansion",
      );
    },
  );

  visibility.registerVisibleTool(
    "agent_status",
    {
      description: "Read current Dynamic DAG V2 run/task status. Omit runId to list recent runs.",
      inputSchema: { runId: RunId.optional() },
    },
    async ({ runId }) => {
      await assertObservationAllowed(control, "agent_status", runId ?? null);
      return result(await control.status(runId ?? null), "agent-status", "AGENT STATUS · authoritative PostgreSQL state");
    },
  );

  visibility.registerVisibleTool(
    "agent_progress",
    {
      description: "Read the human-facing Runtime V2 progress projection without polling or waking the main orchestrator. Returns current/parallel steps, materialized DAG progress, next eligible work and a compact non-additive efficiency summary. Omit runId to select the most recent active run.",
      inputSchema: { runId: RunId.optional() },
    },
    async ({ runId }) => {
      await assertObservationAllowed(control, "agent_progress", runId ?? null);
      return result(
        await control.progress(runId ?? null),
        "agent-progress",
        "AGENT PROGRESS · current Runtime V2 step(s), DAG progress and efficiency",
      );
    },
  );

  visibility.registerVisibleTool(
    "agent_continuation_status",
    {
      description: "Diagnose one durable OpenCode continuation without polling the run: reports whether the run is still waiting for a terminal wake condition, whether a wake was materialized, and the persisted delivery/observation state.",
      inputSchema: { runId: RunId },
    },
    async ({ runId }) => {
      await assertObservationAllowed(control, "agent_continuation_status", runId);
      const status = await control.status(runId) as { run?: unknown; continuation?: unknown };
      return result(
        { runId, run: status.run ?? null, continuation: status.continuation ?? null },
        "agent-continuation-status",
        "AGENT CONTINUATION STATUS · durable wake/delivery state",
      );
    },
  );

  visibility.registerVisibleTool(
    "agent_wait",
    {
      description: "Observation fallback: long-poll one run until its authoritative state changes, persisted task/executor activity advances, terminal status, or timeout. Do not use it as the orchestration mechanism when a durable OpenCode continuation is bound; the Runtime resumes that session from terminal events.",
      inputSchema: {
        runId: RunId,
        afterVersion: z.number().int().min(0).optional(),
        timeoutMs: z.number().int().min(250).max(30_000).optional(),
      },
    },
    async ({ runId, afterVersion, timeoutMs }) => {
      await assertObservationAllowed(control, "agent_wait", runId);
      return result(
        await control.wait(runId, { ...(afterVersion !== undefined ? { afterVersion } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
        "agent-wait",
        "AGENT WAIT · returned on run/activity change, terminal status or bounded timeout",
      );
    },
  );

  visibility.registerVisibleTool(
    "agent_get_dag",
    {
      description: "Return the authoritative DAG currently persisted for a run, including the Technical Lead compiled implementation DAG after refinement.",
      inputSchema: { runId: RunId },
    },
    async ({ runId }) => {
      await assertObservationAllowed(control, "agent_get_dag", runId);
      return result(await control.getDag(runId), "agent-dag", "AGENT DAG · authoritative compiled execution plan");
    },
  );

  visibility.registerVisibleTool(
    "agent_resume",
    {
      description: "Request exceptional reconciliation for a non-terminal persisted run when status explicitly reports needsResume=true. Normal observer disconnects and healthy service restarts recover automatically and do not require resume.",
      inputSchema: { runId: RunId },
    },
    async ({ runId }) => { assertControlCaller(); return result(await control.resume(runId), "agent-run-resumed", "AGENT RUN RESUMED · worker attached to persisted DAG"); },
  );

  visibility.registerVisibleTool(
    "agent_retry",
    {
      description: "Retry one failed/blocked/cancelled task only while its parent run is still non-terminal, subject to the attempt budget and model escalation policy. A terminal run is monotonic and cannot be reopened by agent_retry; replanning after terminal state requires a fresh agent_start after any competing active run for the continuation session has been cleared or deduplicated.",
      inputSchema: { runId: RunId, taskId: TaskId },
    },
    async ({ runId, taskId }) => { assertControlCaller(); return result(await control.retry(runId, taskId), "agent-task-retried", "AGENT TASK RETRIED · run resumed with routing escalation policy"); },
  );

  visibility.registerVisibleTool(
    "agent_cancel",
    {
      description: "Cancel a run. Persisted status is changed first; active task subprocesses observe cancellation and are aborted.",
      inputSchema: { runId: RunId },
    },
    async ({ runId }) => { assertControlCaller(); return result(await control.cancel(runId), "agent-run-cancelled", "AGENT RUN CANCELLED · persisted state updated and active worker signalled"); },
  );

  visibility.registerVisibleTool(
    "agent_summary",
    {
      description: "Return execution/cost/acceptance telemetry plus async dispatch generation, lease/fencing, checkpoint/cleanup and Rust execution-plane health for one run or aggregate recent runs.",
      inputSchema: { runId: RunId.optional() },
    },
    async ({ runId }) => {
      await assertObservationAllowed(control, "agent_summary", runId ?? null);
      return result(await control.summary(runId ?? null), "agent-summary", "AGENT SUMMARY · model, cost, retries and acceptance telemetry");
    },
  );

  visibility.registerVisibleTool(
    "agent_doctor",
    {
      description: "Validate unattended async Runtime V2 prerequisites: PostgreSQL schema through durable continuations/inbox, OpenCode/model catalog, optional continuation endpoint configuration and a recent healthy Rust agent-runtime-worker heartbeat.",
      inputSchema: {},
    },
    async () => result(await control.doctor(), "agent-doctor", "AGENT DOCTOR · unattended runtime readiness"),
  );
}
