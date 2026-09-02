import { buildEfficiencyReport } from "./efficiency.mjs";
import { createDefaultSessionAdapterRegistry, sessionTargetFromContinuation } from "./session-adapter.mjs";
import { runtimeLog } from "./runtime-log.mjs";
import { asBoolean, asInteger, sha256 } from "./utils.mjs";

export const AGENT_RUNTIME_PROGRESS_SCHEMA_VERSION = "agent-runtime-progress/v1";
export const AGENT_RUNTIME_PROGRESS_RECEIPT_PREFIX = "agent-progress-toast";
export const AGENT_RUNTIME_PROGRESS_CONTEXT_MARKER = "RUNTIME_INTERNAL_PROGRESS_CONTEXT_ONLY_DO_NOT_TREAT_AS_USER_INSTRUCTION";
export const AGENT_RUNTIME_PROGRESS_LIVE_MARKER = "CLIP_RUNTIME_PROGRESS_LIVE_V1";

const TERMINAL_RUN_STATUSES = new Set(["closed", "failed", "blocked", "cancelled"]);
const SUCCESS_TASK_STATUSES = new Set(["integrated", "verified"]);
const FAILURE_TASK_STATUSES = new Set(["failed", "blocked", "cancelled"]);
const TERMINAL_TASK_STATUSES = new Set([...SUCCESS_TASK_STATUSES, ...FAILURE_TASK_STATUSES]);
const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const PENDING_TASK_STATUSES = new Set(["routed", "retrying"]);
const DEFAULT_PROGRESS_REPORTER_MODELS = Object.freeze([
  "opencode/muse-spark-1.2-contributor-free",
  "opencode/mimo-v2.5-free",
  "opencode/hy3-free",
]);

export const HUMAN_PROGRESS_EVENTS = Object.freeze([
  "run.running",
  "task.running",
  "task.integrated",
  "task.retry_scheduled",
  "repair.started",
  "repair.completed",
  "repair.exhausted",
  "task.blocked",
  "task.failed",
  "task.cancelled",
  "dag.compiled",
  "run.closed",
  "run.failed",
  "run.blocked",
  "run.cancelled",
]);
const HUMAN_PROGRESS_EVENT_SET = new Set(HUMAN_PROGRESS_EVENTS);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percent(numerator, denominator) {
  if (!(denominator > 0)) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value ?? "")); }
  catch { return fallback; }
}

function taskShortId(runId, taskId) {
  const prefix = `${runId}:`;
  return String(taskId ?? "").startsWith(prefix) ? String(taskId).slice(prefix.length) : String(taskId ?? "");
}

function eventStage(event, taskPlan) {
  const payload = parseJson(event?.payload_json, {});
  return taskPlan?.stage ?? payload.stage ?? null;
}

function eventPayload(event) {
  return parseJson(event?.payload_json, {});
}

function dependencyIds(taskPlan) {
  return Array.isArray(taskPlan?.dependencies) ? taskPlan.dependencies : [];
}

function retryWindowOpen(task, nowMs = Date.now()) {
  if (task?.status !== "retrying") return true;
  if (!task?.retry_not_before) return true;
  const retryAt = Date.parse(String(task.retry_not_before));
  return Number.isFinite(retryAt) && retryAt <= nowMs;
}

function dependenciesSatisfied(taskPlan, byTaskId) {
  return dependencyIds(taskPlan).every((dependencyId) => SUCCESS_TASK_STATUSES.has(byTaskId.get(dependencyId)?.status));
}

function elapsedMs(startedAt, completedAt = null, nowMs = Date.now()) {
  const start = Date.parse(String(startedAt ?? ""));
  if (!Number.isFinite(start)) return null;
  const end = completedAt ? Date.parse(String(completedAt)) : nowMs;
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function controlPlaneStatus(events) {
  let activeFailure = null;
  let consecutiveFailures = 0;
  let lastRecoveredAt = null;
  for (const event of events ?? []) {
    if (event.event_type === "runtime.reconcile_recovered") {
      activeFailure = null;
      consecutiveFailures = 0;
      lastRecoveredAt = event.created_at ?? null;
      continue;
    }
    if (event.event_type !== "runtime.reconcile_failed") continue;
    const payload = eventPayload(event);
    consecutiveFailures += 1;
    activeFailure = {
      eventId: event.event_id ?? null,
      message: String(payload.message ?? "runtime_reconcile_failed"),
      createdAt: event.created_at ?? null,
    };
  }
  return {
    status: activeFailure ? "degraded" : "healthy",
    activeFailure,
    consecutiveFailures,
    lastRecoveredAt,
  };
}

function compactEfficiency(report) {
  if (!report) return null;
  return {
    contractVersion: report.contractVersion,
    observed: {
      model: {
        source: report.observed?.model?.source ?? "pending-observation",
        quality: report.observed?.model?.quality ?? report.observed?.model?.source ?? "pending-observation",
        observedAttemptMeasurements: number(report.observed?.model?.observedAttemptMeasurements),
        fallbackAttemptMeasurements: number(report.observed?.model?.fallbackAttemptMeasurements),
        pendingCurrentAttempts: number(report.observed?.model?.pendingCurrentAttempts),
        inputTokens: number(report.observed?.model?.inputTokens),
        cachedInputTokens: number(report.observed?.model?.cachedInputTokens),
        outputTokens: number(report.observed?.model?.outputTokens),
        costUsd: number(report.observed?.model?.costUsd),
        retryInputTokens: number(report.observed?.model?.retry?.inputTokens),
        retryOutputTokens: number(report.observed?.model?.retry?.outputTokens),
      },
      contextDelivery: {
        contextPreparations: number(report.observed?.contextDelivery?.contextPreparations),
        duplicateContextReadyEventsIgnored: number(report.observed?.contextDelivery?.duplicateContextReadyEventsIgnored),
        rawTokens: number(report.observed?.contextDelivery?.rawTokens),
        deliveredTokens: number(report.observed?.contextDelivery?.deliveredTokens),
        tokensSaved: number(report.observed?.contextDelivery?.tokensSaved),
        savingsPercent: number(report.observed?.contextDelivery?.savingsPercent),
      },
      exactCache: {
        scope: report.observed?.exactCache?.scope ?? "run-execution-context-ready",
        packHits: number(report.observed?.exactCache?.packHits),
        packL1Hits: number(report.observed?.exactCache?.packL1Hits),
        packL2Hits: number(report.observed?.exactCache?.packL2Hits),
        packMisses: number(report.observed?.exactCache?.packMisses),
        prefetch: {
          lookups: number(report.observed?.exactCache?.prefetch?.lookups),
          packHits: number(report.observed?.exactCache?.prefetch?.packHits),
          packMisses: number(report.observed?.exactCache?.prefetch?.packMisses),
        },
      },
    },
    estimated: {
      semanticCache: {
        tokensAvoidedEstimate: number(report.estimated?.semanticCache?.tokensAvoidedEstimate),
        retrievalCallsAvoided: number(report.estimated?.semanticCache?.retrievalCallsAvoided),
        componentsReused: number(report.estimated?.semanticCache?.componentsReused),
      },
    },
    counterfactual: {
      dagAndBudget: {
        budgetHeadroomTokensEstimate: number(report.counterfactual?.dagAndBudget?.budgetHeadroomTokensEstimate),
        budgetOverflowTokensEstimate: number(report.counterfactual?.dagAndBudget?.budgetOverflowTokensEstimate),
        budgetUtilizationPercent: number(report.counterfactual?.dagAndBudget?.budgetUtilizationPercent),
        peakParallel: number(report.counterfactual?.dagAndBudget?.peakParallel),
        observedParallelSpeedup: report.counterfactual?.dagAndBudget?.observedParallelSpeedup ?? null,
      },
    },
    accountingPolicy: {
      grandTotalTokensSaved: null,
      note: "Observed, estimated and counterfactual categories overlap and are intentionally non-additive.",
    },
  };
}

function deterministicSummary(snapshot) {
  const current = snapshot.current.map((task) => task.stage ?? task.shortTaskId).join(" + ");
  const base = current
    ? `${snapshot.progress.terminal}/${snapshot.progress.total} · ${current}`
    : `${snapshot.progress.terminal}/${snapshot.progress.total} · ${snapshot.run.status}`;
  const savings = number(snapshot.efficiency?.observed?.contextDelivery?.tokensSaved);
  return savings > 0 ? `${base} · context saved ${Math.round(savings).toLocaleString("en-US")} tok` : base;
}

function transitionProgressSuffix(snapshot) {
  switch (snapshot.lastTransition?.type) {
    case "task.retry_scheduled": return " · true retry agendado";
    case "repair.started": return " · repair no mesmo attempt";
    case "repair.completed": return " · repair concluído sem full retry";
    case "repair.exhausted": return " · repair esgotado";
    default: return "";
  }
}

function persistentProgressText(snapshot) {
  const count = `${snapshot.progress.terminal}/${snapshot.progress.total} (${snapshot.progress.percent}%)`;
  const current = snapshot.current
    .map((task) => task.stage ?? task.shortTaskId)
    .filter(Boolean)
    .join(" + ");
  const blocked = snapshot.progress.blocked > 0 ? ` · ${snapshot.progress.blocked} bloqueada(s)` : "";
  const failed = snapshot.progress.failed > 0 ? ` · ${snapshot.progress.failed} falha(s)` : "";
  const active = current ? ` — ${current} em execução` : ` — ${snapshot.run.status}`;
  const transition = transitionProgressSuffix(snapshot);
  const saved = number(snapshot.efficiency?.observed?.contextDelivery?.tokensSaved);
  const savings = saved > 0 ? ` · contexto salvo acumulado ${Math.round(saved).toLocaleString("pt-BR")} tok` : "";
  const text = `Runtime V2 · ${count}${active}${transition}${blocked}${failed}${savings}.`;
  return text.length <= 220 ? text : `${text.slice(0, 217).trimEnd()}...`;
}

export async function buildProgressSnapshot(store, requestedRunId = null, { includeEfficiency = true } = {}) {
  let runId = requestedRunId;
  if (!runId) {
    const runs = await store.listRuns(50);
    const selected = runs.find((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? runs[0] ?? null;
    if (!selected) return null;
    runId = selected.run_id;
  }
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run_not_found:${runId}`);
  const [tasks, events] = await Promise.all([store.listTasks(runId), store.listEvents(runId)]);
  const snapshotNowMs = Date.now();
  const heartbeatStaleMs = asInteger(process.env.AGENT_HARNESS_RUNTIME_WORKER_HEARTBEAT_TIMEOUT_MS, 45_000, { min: 5_000, max: 900_000 });
  const executorHeartbeatByTask = new Map();
  for (const event of events) {
    if (event.event_type !== "executor.heartbeat" || !event.task_id) continue;
    executorHeartbeatByTask.set(event.task_id, event);
  }
  const plan = parseJson(run.plan_json, { tasks: [], phase: null });
  const taskPlans = new Map((Array.isArray(plan.tasks) ? plan.tasks : []).map((task) => [task.taskId, task]));
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const success = tasks.filter((task) => SUCCESS_TASK_STATUSES.has(task.status)).length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const terminal = success + failed + blocked + cancelled;
  const running = tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
  const pending = tasks.filter((task) => PENDING_TASK_STATUSES.has(task.status));
  const taskSummaries = tasks.map((task) => ({
    taskId: task.task_id,
    shortTaskId: taskShortId(runId, task.task_id),
    stage: taskPlans.get(task.task_id)?.stage ?? null,
    agentId: task.agent_id,
    role: task.role,
    status: task.status,
    attempt: number(task.attempt),
    maxAttempts: number(task.max_attempts),
    startedAt: task.started_at ?? null,
    completedAt: task.completed_at ?? null,
    errorCode: task.error_code ?? null,
  }));
  const current = running.map((task) => {
    const taskPlan = taskPlans.get(task.task_id);
    return {
      taskId: task.task_id,
      shortTaskId: taskShortId(runId, task.task_id),
      stage: taskPlan?.stage ?? null,
      agentId: task.agent_id,
      role: task.role,
      status: task.status,
      attempt: number(task.attempt),
      maxAttempts: number(task.max_attempts),
      elapsedMs: elapsedMs(task.started_at, task.completed_at, snapshotNowMs),
      modelId: task.model_id ?? null,
      reasoningEffort: task.reasoning_effort ?? null,
      leaseExpiresAt: task.lease_expires_at ?? null,
      liveness: (() => {
        const heartbeat = executorHeartbeatByTask.get(task.task_id) ?? null;
        if (!heartbeat) return {
          heartbeatAt: null,
          heartbeatAgeMs: null,
          heartbeatFresh: false,
          heartbeatStaleAfterMs: heartbeatStaleMs,
          executorElapsedMs: null,
          idleMs: null,
          stdoutBytes: null,
          stderrBytes: null,
        };
        const heartbeatPayload = eventPayload(heartbeat);
        const heartbeatAtMs = Date.parse(String(heartbeat.created_at ?? ""));
        const heartbeatAgeMs = Number.isFinite(heartbeatAtMs) ? Math.max(0, snapshotNowMs - heartbeatAtMs) : null;
        return {
          heartbeatAt: heartbeat.created_at ?? null,
          heartbeatAgeMs,
          heartbeatFresh: heartbeatAgeMs !== null && heartbeatAgeMs <= heartbeatStaleMs,
          heartbeatStaleAfterMs: heartbeatStaleMs,
          executorElapsedMs: number(heartbeatPayload.elapsedMs),
          idleMs: number(heartbeatPayload.idleMs),
          stdoutBytes: number(heartbeatPayload.stdoutBytes),
          stderrBytes: number(heartbeatPayload.stderrBytes),
          dispatchGeneration: number(heartbeatPayload.dispatchGeneration),
          fencingToken: number(heartbeatPayload.fencingToken),
        };
      })(),
    };
  });
  const nextEligible = pending
    .filter((task) => retryWindowOpen(task) && dependenciesSatisfied(taskPlans.get(task.task_id), taskById))
    .map((task) => ({
      taskId: task.task_id,
      shortTaskId: taskShortId(runId, task.task_id),
      stage: taskPlans.get(task.task_id)?.stage ?? null,
      agentId: task.agent_id,
      status: task.status,
      attempt: number(task.attempt),
    }));
  const controlPlane = controlPlaneStatus(events);
  const presentationCheckpoint = latestCommittedProgressCheckpoint(events);
  const humanEvents = events.filter((event) => HUMAN_PROGRESS_EVENT_SET.has(event.event_type));
  const lastEvent = humanEvents.at(-1) ?? null;
  const lastTaskPlan = lastEvent?.task_id ? taskPlans.get(lastEvent.task_id) : null;
  const payload = lastEvent ? eventPayload(lastEvent) : null;
  let efficiency = null;
  if (includeEfficiency) {
    try { efficiency = compactEfficiency(await buildEfficiencyReport(store, runId)); }
    catch (error) {
      runtimeLog("warn", "progress.efficiency_unavailable", { runId, error: error instanceof Error ? error.message : String(error) }, "agent-runtime.progress");
    }
  }
  const snapshot = {
    contractVersion: AGENT_RUNTIME_PROGRESS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    runId,
    run: {
      status: run.status,
      phase: plan.phase ?? null,
      graphVersion: run.graph_version ?? null,
      stateVersion: number(run.state_version),
      startedAt: run.started_at ?? null,
      completedAt: run.completed_at ?? null,
      elapsedMs: elapsedMs(run.started_at, run.completed_at, snapshotNowMs),
      terminal: TERMINAL_RUN_STATUSES.has(run.status),
      dagCompiled: plan.phase === "compiled" || humanEvents.some((event) => event.event_type === "dag.compiled"),
    },
    presentation: {
      tuiEnabled: asBoolean(process.env.AGENT_HARNESS_AGENT_PROGRESS_TUI_ENABLED, true),
      sessionMessagesEnabled: asBoolean(process.env.AGENT_HARNESS_AGENT_PROGRESS_SESSION_MESSAGES_ENABLED, true),
      deliveryMode: "context-engine-tui-readthrough-v2",
      checkpoint: presentationCheckpoint,
      reporterMode: String(process.env.AGENT_HARNESS_AGENT_PROGRESS_REPORTER_MODE ?? "deterministic").trim().toLowerCase(),
      reporterModels: parseReporterModelCandidates(process.env, "AGENT_HARNESS_AGENT_PROGRESS_REPORTER_MODEL", "AGENT_HARNESS_AGENT_PROGRESS_REPORTER_MODELS"),
      sessionReporterModels: parseReporterModelCandidates(process.env, "AGENT_HARNESS_AGENT_PROGRESS_SESSION_REPORTER_MODEL", "AGENT_HARNESS_AGENT_PROGRESS_SESSION_REPORTER_MODELS"),
      reporterSelection: "opencode-provider-catalog",
      mainOrchestratorWakePolicy: "terminal-only",
    },
    progress: {
      total: tasks.length,
      terminal,
      success,
      failed,
      blocked,
      cancelled,
      running: running.length,
      pending: pending.length,
      percent: percent(terminal, tasks.length),
      scope: "materialized-tasks",
      note: plan.phase === "bootstrap"
        ? "The Technical Lead can compile additional implementation tasks; total task count may increase after dag.compiled."
        : "Total task count reflects the compiled implementation DAG.",
    },
    tasks: taskSummaries,
    current,
    nextEligible,
    controlPlane,
    lastTransition: lastEvent ? {
      eventId: lastEvent.event_id,
      type: lastEvent.event_type,
      taskId: lastEvent.task_id,
      shortTaskId: lastEvent.task_id ? taskShortId(runId, lastEvent.task_id) : null,
      stage: eventStage(lastEvent, lastTaskPlan),
      createdAt: lastEvent.created_at,
      status: payload?.status ?? null,
      attempt: payload?.attempt ?? null,
      code: payload?.code ?? null,
    } : null,
    efficiency,
  };
  return { ...snapshot, summary: deterministicSummary(snapshot) };
}

function toastVariant(eventType) {
  if (["run.failed", "run.blocked", "task.failed", "task.blocked"].includes(eventType)) return "error";
  if (["task.retry_scheduled", "repair.started", "repair.exhausted", "task.cancelled", "run.cancelled"].includes(eventType)) return "warning";
  if (["repair.completed", "task.integrated", "dag.compiled", "run.closed"].includes(eventType)) return "success";
  return "info";
}

function eventLabel(event, snapshot) {
  const payload = eventPayload(event);
  const task = snapshot.tasks.find((item) => item.taskId === event.task_id) ?? null;
  const stage = task?.stage ?? payload.stage ?? (event.task_id ? taskShortId(snapshot.runId, event.task_id) : null);
  switch (event.event_type) {
    case "run.running": return "Runtime V2 started";
    case "task.running": return `▶ ${stage ?? "task"} · ${payload.agentId ?? task?.agentId ?? "agent"}`;
    case "task.integrated": return `✓ ${stage ?? "task"} integrated`;
    case "task.retry_scheduled": return `↻ ${stage ?? "task"} true retry ${payload.attempt ?? ""}${payload.retryAfterMs > 0 ? ` in ${Math.round(payload.retryAfterMs / 1000)}s` : " now"}`.trim();
    case "repair.started": return `↺ ${stage ?? "task"} same-attempt repair`;
    case "repair.completed": return `✓ ${stage ?? "task"} repaired without full retry`;
    case "repair.exhausted": return `Repair budget exhausted · ${stage ?? "task"}`;
    case "task.blocked": return `Blocked · ${stage ?? "task"}`;
    case "task.failed": return `Failed · ${stage ?? "task"}`;
    case "task.cancelled": return `Cancelled · ${stage ?? "task"}`;
    case "dag.compiled": return `DAG compiled · ${payload.taskCount ?? snapshot.progress.total} tasks`;
    case "run.closed": return "✓ Runtime V2 completed";
    case "run.failed": return "Runtime V2 failed";
    case "run.blocked": return "Runtime V2 blocked";
    case "run.cancelled": return "Runtime V2 cancelled";
    default: return event.event_type;
  }
}

function toastMessage(event, snapshot, narrative = null) {
  if (narrative) return narrative;
  const label = eventLabel(event, snapshot);
  const suffix = `${snapshot.progress.terminal}/${snapshot.progress.total} · ${snapshot.progress.percent}%`;
  const contextSaved = number(snapshot.efficiency?.observed?.contextDelivery?.tokensSaved);
  const metric = contextSaved > 0 ? ` · saved ${Math.round(contextSaved).toLocaleString("en-US")} tok` : "";
  return `${label} · ${suffix}${metric}`;
}

function splitModelId(value) {
  const model = String(value ?? "").trim();
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return null;
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function parseReporterModelCandidates(environment, singularKey, listKey) {
  const values = [];
  const configured = String(environment[listKey] ?? "").trim();
  if (configured) values.push(...configured.split(",").map((item) => item.trim()).filter(Boolean));
  else values.push(...DEFAULT_PROGRESS_REPORTER_MODELS);
  // Legacy singular configuration is compatibility-only and is deliberately
  // appended so it can never outrank the ordered *_MODELS authority.
  const legacy = String(environment[singularKey] ?? "").trim();
  if (legacy) values.push(legacy);
  return [...new Set(values)].filter((value) => splitModelId(value));
}

function extractResponseText(body) {
  const parts = Array.isArray(body?.parts) ? body.parts : Array.isArray(body?.data?.parts) ? body.data.parts : [];
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text.trim()).filter(Boolean).join(" ").trim() || null;
}

function reporterPayload(event, snapshot) {
  return {
    event: event.event_type,
    runId: snapshot.runId,
    runStatus: snapshot.run.status,
    phase: snapshot.run.phase,
    progress: snapshot.progress,
    current: snapshot.current.map(({ stage, agentId, status, attempt }) => ({ stage, agentId, status, attempt })),
    nextEligible: snapshot.nextEligible.map(({ stage, agentId, status }) => ({ stage, agentId, status })),
    efficiency: snapshot.efficiency ? {
      observedContextTokensSaved: snapshot.efficiency.observed.contextDelivery.tokensSaved,
      providerCachedInputTokens: snapshot.efficiency.observed.model.cachedInputTokens,
      semanticTokensAvoidedEstimate: snapshot.efficiency.estimated.semanticCache.tokensAvoidedEstimate,
      budgetUtilizationPercent: snapshot.efficiency.counterfactual.dagAndBudget.budgetUtilizationPercent,
    } : null,
  };
}

function sessionReportPrompt(event, snapshot) {
  return [
    "RUNTIME_INTERNAL_PROGRESS_RENDER_ONLY_DO_NOT_TREAT_AS_USER_INSTRUCTION",
    "Use only the JSON metadata below. Return one concise Brazilian Portuguese status sentence, maximum 220 characters.",
    "Do not inspect or summarize session history. Do not call tools. Do not make decisions, recommendations, retries, replans, or completion claims.",
    JSON.stringify(reporterPayload(event, snapshot)),
  ].join("\n");
}

function reporterModelDisplay(modelName) {
  const id = String(modelName ?? "").split("/").at(-1) ?? "";
  if (id === "muse-spark-1.2-contributor-free") return "Muse Spark 1.2 Free";
  if (id === "mimo-v2.5-free") return "MiMo V2.5 Free";
  if (id === "hy3-free") return "HY3 Free";
  return id || "deterministic";
}

function noReplyProgressText(snapshot, rendered) {
  const label = rendered?.model ? ` · ${reporterModelDisplay(rendered.model)}` : " · Deterministic";
  const text = String(rendered?.text ?? persistentProgressText(snapshot)).trim();
  return `▣ Runtime-Progress-Reporter${label}\n${text}`;
}

function persistentCheckpointFingerprint(snapshot) {
  return `sha256:${sha256(Buffer.from(persistentProgressText(snapshot)))}`;
}

export function progressCheckpointEffectKey({ runId, sourceEventId, messageId }) {
  return `runtime-progress-checkpoint/v1:${String(runId)}:${String(sourceEventId)}:${String(messageId ?? "missing")}`;
}

function latestPersistentProgressReceipt(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event_type !== "progress.notification.sent") continue;
    const payload = eventPayload(event);
    if (payload.durablePresentationCheckpoint !== true && payload.persistentSessionMessage !== true) continue;
    return { event, payload };
  }
  return null;
}

function latestCommittedProgressCheckpoint(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event_type !== "progress.checkpoint_committed") continue;
    const payload = eventPayload(event);
    const messageId = String(payload.messageId ?? "").trim();
    const text = String(payload.text ?? "").trim();
    if (!messageId || !text) continue;
    const createdAt = Date.parse(String(event.created_at ?? ""));
    return {
      messageId,
      text,
      sourceEventId: payload.sourceEventId ?? null,
      sourceEventType: payload.sourceEventType ?? null,
      effectKey: payload.effectKey ?? event.effect_key ?? null,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      deliveryMode: payload.deliveryMode ?? null,
    };
  }
  return null;
}

function reporterFailureMetadata(error) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
  const statusMatch = message.match(/(?:http:|_http:)(\d{3})/i) ?? message.match(/\bhttp(?:Status)?[=:](\d{3})/i);
  const timeout = /timeout|timed out|aborted due to timeout|aborterror/i.test(message);
  return {
    message,
    httpStatus: statusMatch ? Number(statusMatch[1]) : null,
    timeout,
  };
}

function progressReportEffectKey(event, continuation) {
  const canonical = JSON.stringify({
    runId: continuation.run_id,
    adapterId: continuation.session_adapter_id ?? continuation.adapterId ?? "opencode",
    sessionId: continuation.session_id ?? continuation.opencode_session_id ?? continuation.sessionId,
    sourceEventId: event.event_id,
    sourceEventType: event.event_type,
  });
  return `sha256:${sha256(Buffer.from(canonical))}`;
}

export class AgentProgressProjector {
  constructor({ environment = process.env, fetchImpl = globalThis.fetch, sessionAdapters = null } = {}) {
    this.id = "runtime-progress";
    this.environment = environment;
    this.fetchImpl = fetchImpl;
    this.sessionAdapters = sessionAdapters ?? createDefaultSessionAdapterRegistry({ environment, fetchImpl });
    this.tuiEnabled = asBoolean(environment.AGENT_HARNESS_AGENT_PROGRESS_TUI_ENABLED, true);
    this.sessionMessagesEnabled = asBoolean(environment.AGENT_HARNESS_AGENT_PROGRESS_SESSION_MESSAGES_ENABLED, true);
    this.enabled = this.tuiEnabled || this.sessionMessagesEnabled;
    this.reporterMode = String(environment.AGENT_HARNESS_AGENT_PROGRESS_REPORTER_MODE ?? "deterministic").trim().toLowerCase();
    this.reporterModels = parseReporterModelCandidates(environment, "AGENT_HARNESS_AGENT_PROGRESS_REPORTER_MODEL", "AGENT_HARNESS_AGENT_PROGRESS_REPORTER_MODELS");
    this.sessionReporterModels = parseReporterModelCandidates(environment, "AGENT_HARNESS_AGENT_PROGRESS_SESSION_REPORTER_MODEL", "AGENT_HARNESS_AGENT_PROGRESS_SESSION_REPORTER_MODELS");
    this.reporterTimeoutMs = asInteger(environment.AGENT_HARNESS_AGENT_PROGRESS_REPORTER_TIMEOUT_MS, 15_000, { min: 1_000, max: 60_000 });
    this.sessionReportTimeoutMs = asInteger(environment.AGENT_HARNESS_AGENT_PROGRESS_SESSION_TIMEOUT_MS, 30_000, { min: 2_000, max: 120_000 });
    this.toastTimeoutMs = asInteger(environment.AGENT_HARNESS_AGENT_PROGRESS_TUI_TIMEOUT_MS, 5_000, { min: 500, max: 30_000 });
    this.catalogTtlMs = asInteger(environment.AGENT_HARNESS_AGENT_PROGRESS_REPORTER_CATALOG_TTL_MS, 60_000, { min: 1_000, max: 600_000 });
    this.seen = new Set();
    this.providerCatalogs = new Map();
    this.noReplyCapabilities = new Map();
    this.reporterStates = new Map();
    this.reporterFailureThreshold = asInteger(environment.AGENT_HARNESS_AGENT_PROGRESS_REPORTER_FAILURE_THRESHOLD, 2, { min: 1, max: 10 });
    this.reporterCircuitOpenMs = asInteger(environment.AGENT_HARNESS_AGENT_PROGRESS_REPORTER_CIRCUIT_OPEN_MS, 60_000, { min: 1_000, max: 900_000 });
    this.narrativePending = new Map();
    this.narrativeActive = new Set();
    this.lastPersistentCheckpoints = new Map();
  }

  sessionContext(continuation, sessionId = null) {
    const baseTarget = sessionTargetFromContinuation(continuation);
    const target = sessionId ? { ...baseTarget, sessionId } : baseTarget;
    return { target, adapter: this.sessionAdapters.resolve(target.adapterId) };
  }

  sessionCacheKey(continuation) {
    const { target } = this.sessionContext(continuation);
    return `${target.adapterId}|${target.serverUrl}|${target.directory ?? ""}`;
  }

  async providerCatalog(continuation) {
    const key = this.sessionCacheKey(continuation);
    const cached = this.providerCatalogs.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    const { target, adapter } = this.sessionContext(continuation);
    const models = await adapter.availableModels(target);
    this.providerCatalogs.set(key, { models, expiresAt: Date.now() + this.catalogTtlMs });
    return models;
  }

  invalidateProviderCatalog(continuation) {
    this.providerCatalogs.delete(this.sessionCacheKey(continuation));
  }

  async availableReporterModels(continuation, candidates) {
    const catalog = await this.providerCatalog(continuation);
    return candidates.filter((candidate) => catalog.has(candidate));
  }

  reporterState(runId, channel = "toast") {
    const key = `${runId}:${channel}`;
    if (!this.reporterStates.has(key)) {
      this.reporterStates.set(key, { preferredModel: null, failures: new Map(), circuitUntil: new Map() });
    }
    return this.reporterStates.get(key);
  }

  orderedReporterModels(runId, models, channel = "toast") {
    const state = this.reporterState(runId, channel);
    const now = Date.now();
    const available = models.filter((model) => Number(state.circuitUntil.get(model) ?? 0) <= now);
    const preferred = state.preferredModel && available.includes(state.preferredModel) ? state.preferredModel : null;
    return preferred ? [preferred, ...available.filter((model) => model !== preferred)] : available;
  }

  recordReporterSuccess({ runId, model, channel = "toast", latencyMs = null }) {
    const state = this.reporterState(runId, channel);
    state.preferredModel = model;
    state.failures.set(model, 0);
    state.circuitUntil.delete(model);
    runtimeLog("info", "progress.reporter_selected", { runId, model, channel, sticky: true, latencyMs }, "agent-runtime.progress");
  }

  recordReporterFailure({ runId, eventId = null, model, channel = "toast", error, latencyMs = null }) {
    const state = this.reporterState(runId, channel);
    const count = Number(state.failures.get(model) ?? 0) + 1;
    state.failures.set(model, count);
    const details = reporterFailureMetadata(error);
    let circuitOpened = false;
    let circuitUntil = null;
    if (count >= this.reporterFailureThreshold) {
      circuitUntil = Date.now() + this.reporterCircuitOpenMs;
      state.circuitUntil.set(model, circuitUntil);
      if (state.preferredModel === model) state.preferredModel = null;
      circuitOpened = true;
    }
    runtimeLog("warn", "progress.reporter_candidate_failed", {
      runId, eventId, model, channel, reason: details.message, httpStatus: details.httpStatus, timeout: details.timeout, latencyMs,
      consecutiveFailures: count, circuitOpened, circuitUntil: circuitUntil ? new Date(circuitUntil).toISOString() : null,
    }, "agent-runtime.progress");
    if (circuitOpened) {
      runtimeLog("warn", "progress.reporter_circuit_opened", {
        runId, model, channel, consecutiveFailures: count, reopenAt: new Date(circuitUntil).toISOString(),
      }, "agent-runtime.progress");
    }
  }

  async targetSessionIdle(continuation) {
    const { target, adapter } = this.sessionContext(continuation);
    return await adapter.isIdle(target);
  }

  async sessionReportAlreadyExists(continuation, messageId) {
    const { target, adapter } = this.sessionContext(continuation);
    return await adapter.messageExists(target, messageId);
  }

  async noReplySupported(continuation) {
    const key = this.sessionCacheKey(continuation);
    if (this.noReplyCapabilities.has(key)) return this.noReplyCapabilities.get(key);

    const { target: mainTarget, adapter } = this.sessionContext(continuation);
    let probeSessionId = null;
    try {
      probeSessionId = await adapter.createSession(mainTarget, { title: "Clip Runtime noReply capability probe" });
      const probeTarget = { ...mainTarget, sessionId: probeSessionId };
      const messageId = this.sessionAdapters.buildMessageId(mainTarget.adapterId, {
        effectKey: `sha256:${sha256(Buffer.from(`progress-noreply-probe|${key}`))}`,
        createdAt: new Date().toISOString(),
      });
      const result = await adapter.appendContext(probeTarget, {
        messageId,
        text: "RUNTIME_INTERNAL_PROGRESS_NOREPLY_CAPABILITY_PROBE",
      });
      if (result?.role !== "user") throw new Error(`agent_progress_noreply_probe_unexpected_role:${result?.role ?? "missing"}`);
      if (!(await adapter.isIdle(probeTarget))) throw new Error("agent_progress_noreply_probe_session_not_idle");
      const messages = await adapter.listMessages(probeTarget);
      const assistantMessages = Array.isArray(messages)
        ? messages.filter((message) => (message?.info?.role ?? message?.role) === "assistant")
        : [];
      if (assistantMessages.length > 0) throw new Error("agent_progress_noreply_probe_unexpected_assistant_message");

      this.noReplyCapabilities.set(key, true);
      const proof = {
        adapterId: mainTarget.adapterId,
        serverUrl: mainTarget.serverUrl,
        probeSessionId,
        capability: "safe-context-only-persistence",
        livePresentationProven: false,
      };
      runtimeLog("info", "progress.noreply_persistence_proven", proof, "agent-runtime.progress");
      runtimeLog("info", "progress.noreply_capability_proven", {
        ...proof,
        compatibilityAliasFor: "progress.noreply_persistence_proven",
      }, "agent-runtime.progress");
      return true;
    } catch (error) {
      this.noReplyCapabilities.set(key, false);
      const unavailable = {
        adapterId: mainTarget.adapterId,
        serverUrl: mainTarget.serverUrl,
        error: error instanceof Error ? error.message : String(error),
      };
      runtimeLog("warn", "progress.noreply_persistence_unavailable", unavailable, "agent-runtime.progress");
      runtimeLog("warn", "progress.noreply_capability_unavailable", {
        ...unavailable,
        compatibilityAliasFor: "progress.noreply_persistence_unavailable",
      }, "agent-runtime.progress");
      return false;
    } finally {
      if (probeSessionId) await adapter.deleteSession(mainTarget, probeSessionId).catch(() => null);
    }
  }

  async renderPersistentCheckpoint(_event, snapshot, _continuation) {
    // Persistent/live progress must never wait for an LLM. Narrative enrichment
    // is presentation-only and runs asynchronously after the checkpoint receipt
    // is committed.
    return { text: persistentProgressText(snapshot), model: null, deterministic: true };
  }

  async sendPersistentSessionReport(event, snapshot, continuation) {
    if (!this.sessionMessagesEnabled || snapshot.run.terminal) return { delivered: false, skipped: true };

    // R15.6.12: OpenCode can schedule a phantom assistant loop when a silent/noReply
    // user message is inserted into the continuation-bound main session. The main
    // session is therefore immutable while the Runtime is parked. Persist the
    // deterministic checkpoint in Runtime authority and let the attached TUI read
    // it through /runtime-progress-live instead of POSTing a user message.
    const rendered = await this.renderPersistentCheckpoint(event, snapshot, continuation);
    runtimeLog("info", "progress.report_rendered", {
      runId: snapshot.runId,
      sourceEventId: event.event_id,
      sourceEventType: event.event_type,
      model: rendered.model,
      renderer: rendered.deterministic ? "deterministic" : "isolated-free-model",
      target: "durable-presentation-checkpoint",
    }, "agent-runtime.progress");

    const effectKey = progressReportEffectKey(event, continuation);
    const { target } = this.sessionContext(continuation);
    const messageId = this.sessionAdapters.buildMessageId(target.adapterId, {
      effectKey,
      createdAt: event.created_at,
    });
    return {
      delivered: true,
      observed: false,
      messageId,
      text: noReplyProgressText(snapshot, rendered),
      model: rendered.model,
      deliveryMode: "checkpoint-readthrough",
      mainSessionMutated: false,
    };
  }

  async reporterSession(continuation) {
    // Reporter sessions are deliberately ephemeral and unparented. They must not
    // accumulate history or become part of the continuation-bound main session.
    const { target, adapter } = this.sessionContext(continuation);
    return await adapter.createSession(target, { title: `Clip Runtime Progress · ${continuation.run_id.slice(-8)}` });
  }

  async deleteReporterSession(continuation, sessionId) {
    if (!sessionId) return;
    const { target, adapter } = this.sessionContext(continuation);
    await adapter.deleteSession(target, sessionId).catch(() => null);
  }

  async renderWithFreeModel(event, snapshot, continuation) {
    if (this.reporterMode !== "free-model") return null;
    let models;
    try { models = await this.availableReporterModels(continuation, this.reporterModels); }
    catch (error) {
      runtimeLog("warn", "progress.reporter_catalog_unavailable", {
        runId: snapshot.runId, eventId: event.event_id, candidates: this.reporterModels,
        error: error instanceof Error ? error.message : String(error),
      }, "agent-runtime.progress");
      return null;
    }
    models = this.orderedReporterModels(snapshot.runId, models, "toast");
    if (models.length === 0) return null;
    const sessionId = await this.reporterSession(continuation);
    let lastError = null;
    try {
      for (const modelName of models) {
        const body = {
          model: splitModelId(modelName),
          agent: "runtime-progress-reporter",
          system: "You are a non-authoritative runtime progress reporter. Use only the supplied JSON metadata. Never call tools, never inspect source code, never make decisions, and never claim completion. Return one concise Brazilian Portuguese sentence, maximum 180 characters.",
          parts: [{ type: "text", text: JSON.stringify(reporterPayload(event, snapshot)) }],
        };
        const startedAt = Date.now();
        try {
          const { target, adapter } = this.sessionContext(continuation);
          const responseBody = await adapter.sendMessage(target, { sessionId, body });
          const text = extractResponseText(responseBody);
          if (!text) throw new Error(`agent_progress_reporter_text_missing:${modelName}`);
          this.recordReporterSuccess({ runId: snapshot.runId, model: modelName, channel: "toast", latencyMs: Date.now() - startedAt });
          return { text, model: modelName };
        } catch (error) {
          lastError = error;
          this.recordReporterFailure({ runId: snapshot.runId, eventId: event.event_id, model: modelName, channel: "toast", error, latencyMs: Date.now() - startedAt });
        }
      }
    } finally {
      await this.deleteReporterSession(continuation, sessionId);
    }
    runtimeLog("warn", "progress.reporter_fallback", {
      runId: snapshot.runId, eventId: event.event_id, candidates: models,
      error: lastError instanceof Error ? lastError.message : String(lastError ?? "no_reporter_result"),
    }, "agent-runtime.progress");
    return null;
  }

  scheduleNarrativeEnrichment(event, snapshot, continuation) {
    if (!this.tuiEnabled) return;
    this.narrativePending.set(snapshot.runId, { event, snapshot, continuation });
    runtimeLog("info", "progress.narrative_enrichment_scheduled", {
      runId: snapshot.runId, eventId: event.event_id, nonBlocking: true,
    }, "agent-runtime.progress");
    if (this.narrativeActive.has(snapshot.runId)) return;
    this.narrativeActive.add(snapshot.runId);
    queueMicrotask(() => { void this.drainNarrativeEnrichment(snapshot.runId); });
  }

  async drainNarrativeEnrichment(runId) {
    try {
      while (this.narrativePending.has(runId)) {
        const next = this.narrativePending.get(runId);
        this.narrativePending.delete(runId);
        try {
          const toast = await this.showToast(next.event, next.snapshot, next.continuation);
          runtimeLog("info", "progress.toast_sent", {
            runId, sourceEventId: next.event.event_id, sourceEventType: next.event.event_type,
            reporterMode: this.reporterMode, serverAccepted: true, livePresentationProven: false, asyncNarrative: true,
          }, "agent-runtime.progress");
          runtimeLog("info", "progress.narrative_enrichment_completed", {
            runId, eventId: next.event.event_id, reporterModel: toast?.reporterModel ?? null, authoritative: false,
          }, "agent-runtime.progress");
        } catch (error) {
          runtimeLog("warn", "progress.narrative_enrichment_failed", {
            runId, eventId: next.event.event_id, error: error instanceof Error ? error.message : String(error), authoritative: false,
          }, "agent-runtime.progress");
        }
      }
    } finally {
      this.narrativeActive.delete(runId);
      if (this.narrativePending.has(runId)) this.scheduleNarrativeEnrichment(
        this.narrativePending.get(runId).event,
        this.narrativePending.get(runId).snapshot,
        this.narrativePending.get(runId).continuation,
      );
    }
  }

  async showToast(event, snapshot, continuation) {
    if (!this.tuiEnabled) return { delivered: false, skipped: true };
    let narrative = null;
    let reporterModel = null;
    if (this.reporterMode === "free-model") {
      try {
        const rendered = await this.renderWithFreeModel(event, snapshot, continuation);
        narrative = rendered?.text ?? null;
        reporterModel = rendered?.model ?? null;
      } catch (error) {
        runtimeLog("warn", "progress.reporter_fallback", {
          runId: snapshot.runId,
          eventId: event.event_id,
          candidates: this.reporterModels,
          error: error instanceof Error ? error.message : String(error),
        }, "agent-runtime.progress");
      }
    }
    const { target, adapter } = this.sessionContext(continuation);
    await adapter.showToast(target, {
      title: `Runtime V2 · ${snapshot.runId.slice(-8)}`,
      message: toastMessage(event, snapshot, narrative),
      variant: toastVariant(event.event_type),
    });
    return { delivered: true, reporterModel };
  }

  async projectRun(store, runId) {
    if (!this.enabled) return { enabled: false, projected: 0 };
    const continuation = await store.getContinuation(runId).catch(() => null);
    if (!continuation) return { enabled: true, projected: 0, reason: "continuation_not_bound" };
    const continuationBoundAt = Date.parse(String(continuation.created_at ?? ""));
    const allEvents = await store.listEvents(runId);
    const events = allEvents.filter((event) => {
      if (!HUMAN_PROGRESS_EVENT_SET.has(event.event_type)) return false;
      if (!Number.isFinite(continuationBoundAt)) return true;
      const eventAt = Date.parse(String(event.created_at ?? ""));
      return Number.isFinite(eventAt) && eventAt >= continuationBoundAt;
    });

    const pending = [];
    for (const event of events) {
      if (this.seen.has(event.event_id)) continue;
      if (await store.hasProgressNotificationReceipt?.(event.event_id)) {
        this.seen.add(event.event_id);
        continue;
      }
      pending.push(event);
    }
    if (pending.length === 0) return { enabled: true, projected: 0, reports: 0, coalesced: 0 };

    const snapshot = await buildProgressSnapshot(store, runId, { includeEfficiency: true });
    const checkpointFingerprint = persistentCheckpointFingerprint(snapshot);
    const previousPersistentReceipt = this.lastPersistentCheckpoints.get(runId) ?? latestPersistentProgressReceipt(allEvents);

    // Non-terminal progress is checkpoint based, not FIFO event replay. R15.6.12
    // keeps the continuation-bound main session immutable while parked: the newest
    // deterministic checkpoint is persisted in Runtime authority and the attached
    // TUI reads it through /runtime-progress-live. This avoids OpenCode phantom
    // assistant turns caused by silent/noReply user-message insertion.
    if (this.sessionMessagesEnabled && !snapshot.run.terminal) {
      const checkpointEvent = pending.at(-1);
      if (previousPersistentReceipt?.payload?.checkpointFingerprint === checkpointFingerprint) {
        const previousMessageId = previousPersistentReceipt.payload.messageId ?? null;
        for (const event of pending) {
          await store.recordProgressNotificationReceipt?.(event, {
            reporterMode: this.reporterMode,
            reporterModel: null,
            reporterCandidates: this.reporterModels,
            persistentSessionMessage: false,
            durablePresentationCheckpoint: true,
            persistenceCommitted: true,
            liveProjectionChannel: "context-engine-tui-readthrough-v2",
            liveDeliveryObservation: "existing-equivalent-checkpoint",
            deliveryMode: "checkpoint-readthrough",
            noReply: false,
            toastDelivered: false,
            toastServerAccepted: false,
            messageId: previousMessageId,
            coalescedToSourceEventId: previousPersistentReceipt.payload.sourceEventId ?? null,
            coalescedEventCount: pending.length,
            checkpointFingerprint,
            equivalentCheckpoint: true,
          });
          this.seen.add(event.event_id);
        }
        runtimeLog("info", "progress.equivalent_checkpoint_coalesced", {
          runId,
          sourceEventId: checkpointEvent.event_id,
          sourceEventType: checkpointEvent.event_type,
          messageId: previousMessageId,
          checkpointFingerprint,
          coveredEvents: pending.length,
          authoritative: false,
        }, "agent-runtime.progress");
        this.lastPersistentCheckpoints.set(runId, previousPersistentReceipt);
        return {
          enabled: true,
          projected: pending.length,
          reports: 0,
          coalesced: pending.length,
          equivalentCheckpoint: true,
        };
      }
      let sessionReport;
      try {
        sessionReport = await this.sendPersistentSessionReport(checkpointEvent, snapshot, continuation);
      } catch (error) {
        runtimeLog("warn", "progress.session_report_failed", {
          runId,
          sourceEventId: checkpointEvent.event_id,
          sourceEventType: checkpointEvent.event_type,
          pendingEvents: pending.length,
          error: error instanceof Error ? error.message : String(error),
        }, "agent-runtime.progress");
        return { enabled: true, projected: 0, reports: 0, coalesced: 0, pending: pending.length };
      }
      if (sessionReport.deferred) {
        runtimeLog("info", "progress.session_report_deferred", {
          runId,
          sourceEventId: checkpointEvent.event_id,
          sourceEventType: checkpointEvent.event_type,
          reason: sessionReport.reason,
          pendingEvents: pending.length,
          coalescing: true,
        }, "agent-runtime.progress");
        return {
          enabled: true,
          projected: 0,
          reports: 0,
          coalesced: 0,
          pending: pending.length,
          reason: sessionReport.reason,
        };
      }
      if (sessionReport.delivered !== true) {
        return { enabled: true, projected: 0, reports: 0, coalesced: 0, pending: pending.length };
      }

      // Commit persistence/live-readthrough authority before any optional LLM
      // narrative or server-side toast. Narrative enrichment is best-effort and
      // must never hold the presentation projector open.
      for (const event of pending) {
        await store.recordProgressNotificationReceipt?.(event, {
          reporterMode: this.reporterMode,
          reporterModel: null,
          reporterCandidates: this.reporterModels,
          persistentSessionMessage: false,
          durablePresentationCheckpoint: true,
          persistenceCommitted: true,
          liveProjectionChannel: "context-engine-tui-readthrough-v2",
          liveDeliveryObservation: "pending-tui-observation",
          deliveryMode: sessionReport.deliveryMode ?? null,
          noReply: false,
          toastDelivered: false,
          toastServerAccepted: false,
          messageId: sessionReport.messageId ?? null,
          coalescedToSourceEventId: checkpointEvent.event_id,
          coalescedEventCount: pending.length,
          checkpointFingerprint,
          equivalentCheckpoint: false,
        });
        this.seen.add(event.event_id);
      }
      const committed = {
        runId,
        sourceEventId: checkpointEvent.event_id,
        sourceEventType: checkpointEvent.event_type,
        messageId: sessionReport.messageId ?? null,
        model: sessionReport.model ?? null,
        deliveryMode: sessionReport.deliveryMode ?? null,
        noReply: false,
        persistenceCommitted: true,
        liveProjectionChannel: "context-engine-tui-readthrough-v2",
        liveDeliveryObservation: "pending-tui-observation",
        commitScope: "persistence",
        coveredEvents: pending.length,
        checkpointFingerprint,
        authoritative: false,
        presentationOnly: true,
        mainSessionMutated: false,
        text: sessionReport.text ?? null,
      };
      const checkpointEffectKey = progressCheckpointEffectKey({
        runId,
        sourceEventId: checkpointEvent.event_id,
        messageId: sessionReport.messageId ?? null,
      });
      const checkpointPayload = { ...committed, effectKey: checkpointEffectKey };
      if (typeof store.eventOnce === "function") {
        await store.eventOnce(runId, checkpointEvent.task_id ?? null, "progress.checkpoint_committed", checkpointPayload, checkpointEffectKey);
      } else if (typeof store.event === "function") {
        await store.event(runId, checkpointEvent.task_id ?? null, "progress.checkpoint_committed", checkpointPayload);
      } else {
        runtimeLog("info", "progress.checkpoint_committed", checkpointPayload, "agent-runtime.progress");
      }
      runtimeLog("info", "progress.session_checkpoint_committed", {
        ...checkpointPayload,
        compatibilityAliasFor: "progress.checkpoint_committed",
      }, "agent-runtime.progress");
      this.lastPersistentCheckpoints.set(runId, {
        event: null,
        payload: {
          sourceEventId: checkpointEvent.event_id,
          sourceEventType: checkpointEvent.event_type,
          messageId: sessionReport.messageId ?? null,
          persistentSessionMessage: false,
          durablePresentationCheckpoint: true,
          checkpointFingerprint,
        },
      });
      if (this.tuiEnabled) {
        runtimeLog("info", "progress.live_delivery_attempted", {
          runId, sourceEventId: checkpointEvent.event_id, sourceEventType: checkpointEvent.event_type,
          channel: "context-engine-tui-readthrough-v2", authoritative: false,
        }, "agent-runtime.progress");
        this.scheduleNarrativeEnrichment(checkpointEvent, snapshot, continuation);
      }
      return {
        enabled: true,
        projected: pending.length,
        reports: 1,
        coalesced: Math.max(0, pending.length - 1),
      };
    }

    // Terminal progress remains owned by Durable Continuation. When persistent
    // reporting is disabled, TUI-only mode retains the original event projection.
    let projected = 0;
    for (const event of pending) {
      let toastDelivered = false;
      let toastReporterModel = null;
      if (this.tuiEnabled) {
        try {
          runtimeLog("info", "progress.live_delivery_attempted", {
            runId, sourceEventId: event.event_id, sourceEventType: event.event_type,
            channel: "server-tui-toast", authoritative: false,
          }, "agent-runtime.progress");
          const toast = await this.showToast(event, snapshot, continuation);
          toastDelivered = true;
          toastReporterModel = toast?.reporterModel ?? null;
          runtimeLog("info", "progress.toast_sent", {
            runId, sourceEventId: event.event_id, sourceEventType: event.event_type, reporterMode: this.reporterMode,
            serverAccepted: true, livePresentationProven: false,
          }, "agent-runtime.progress");
        } catch (error) {
          runtimeLog("warn", "progress.toast_failed", {
            runId, sourceEventId: event.event_id, sourceEventType: event.event_type,
            error: error instanceof Error ? error.message : String(error),
          }, "agent-runtime.progress");
        }
      }

      const delivered = snapshot.run.terminal
        ? toastDelivered || !this.tuiEnabled
        : toastDelivered;
      if (!delivered) break;

      await store.recordProgressNotificationReceipt?.(event, {
        reporterMode: this.reporterMode,
        reporterModel: toastReporterModel,
        reporterCandidates: this.reporterModels,
        persistentSessionMessage: false,
        toastDelivered,
      });
      this.seen.add(event.event_id);
      projected += 1;
    }
    return { enabled: true, projected, reports: 0, coalesced: 0 };
  }
}

export function progressReceiptEventId(sourceEventId) {
  return `${AGENT_RUNTIME_PROGRESS_RECEIPT_PREFIX}-${sha256(Buffer.from(String(sourceEventId))).slice(0, 40)}`;
}
