const TERMINAL_TASK_STATUSES = new Set(["integrated", "verified", "failed", "blocked", "cancelled"]);

export const DEFAULT_RUNTIME_PERFORMANCE_SLO = Object.freeze({
  normalRunWallMs: 90 * 60_000,
  maxTaskWallMs: 15 * 60_000,
  p95TaskWallMs: 12 * 60_000,
  p95QueueWaitMs: 30_000,
  p95PreparationMs: 90_000,
  p95FinalizationMs: 90_000,
  minParallelSpeedupWhenOpportunity: 1.15,
  parallelOpportunityThreshold: 1.25,
  // R17.4: retry quality is classified by durable retry.true_scheduled evidence.
  // A bounded semantic recovery may be acceptable when wall-clock stays healthy;
  // infrastructure, repair-exhausted and unclassified retries remain fail-closed.
  requireZeroRetries: false,
  maxSemanticRetries: 1,
  maxRetryWallShareOfRun: 0.25,
  maxAttemptsPerTask: 2,
  requireZeroTransientRetries: true,
  requireZeroRepairExhaustedRetries: true,
  requireZeroUnclassifiedRetries: true,
});

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function epoch(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function payload(event) {
  try {
    const value = JSON.parse(event?.payload_json ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function eventEpoch(event) {
  const value = payload(event);
  return epoch(value.observedAt) ?? epoch(event?.created_at);
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function duration(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function first(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length > 0 ? Math.min(...usable) : null;
}

function last(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length > 0 ? Math.max(...usable) : null;
}

function attemptIdentity(event, task) {
  const value = finite(payload(event).attempt);
  return value && value > 0 ? value : Math.max(1, finite(task?.attempt) ?? 1);
}

function phaseSummary(values) {
  return {
    count: values.filter(Number.isFinite).length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: values.filter(Number.isFinite).length > 0 ? Math.max(...values.filter(Number.isFinite)) : null,
  };
}

function executionModeForAttempt(events) {
  for (const event of events) {
    const mode = payload(event).executionMode;
    if (mode) return mode;
  }
  return "agent";
}

function buildAttemptReport(task, attempt, events) {
  const byType = (type) => events.filter((event) => event.event_type === type);
  const preparationStarted = first(byType("task.preparation.started").map(eventEpoch));
  const descriptorReady = last(byType("execution.descriptor.ready").map(eventEpoch));
  const queued = first(byType("task.queued").map(eventEpoch));
  const running = first(byType("task.running").map(eventEpoch));
  const workspaceReady = first(byType("workspace.ready").map(eventEpoch));
  const executorSpawned = first(byType("executor.spawned").map(eventEpoch));
  const executorCompletedEvent = last(byType("executor.completed").map(eventEpoch));
  const openCodeLaunching = first(byType("opencode.launching").map(eventEpoch));
  const openCodeSpawned = first(byType("opencode.spawned").map(eventEpoch));
  const openCodeCompleted = last(byType("opencode.completed").map(eventEpoch));
  const modelUsagePayload = byType("model.usage.observed").map(payload).at(-1) ?? {};
  const auxiliaryInvocations = Array.isArray(modelUsagePayload.auxiliaryInvocations) ? modelUsagePayload.auxiliaryInvocations : [];
  const auxiliaryInvocationCount = Math.max(0, finite(modelUsagePayload.auxiliaryInvocationCount) ?? auxiliaryInvocations.length);
  const hasAuxiliaryWallMs = (value) => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0;
  const timedAuxiliaryInvocations = auxiliaryInvocations.filter((item) => hasAuxiliaryWallMs(item?.wallMs));
  const auxiliaryTimingMissingCount = auxiliaryInvocationCount > 0
    ? Math.max(0, auxiliaryInvocationCount - timedAuxiliaryInvocations.length)
    : 0;
  const payloadAuxiliaryWallMs = hasAuxiliaryWallMs(modelUsagePayload.auxiliaryWallMs) ? Number(modelUsagePayload.auxiliaryWallMs) : null;
  const auxiliaryModelMs = auxiliaryInvocationCount === 0
    ? 0
    : auxiliaryTimingMissingCount === 0
      ? (payloadAuxiliaryWallMs ?? timedAuxiliaryInvocations.reduce((sum, item) => sum + Number(item.wallMs), 0))
      : null;
  const repairResumeSkippedFullAgent = byType("repair.resume_checkpoint_loaded").some((event) => payload(event).skippedFullAgentInvocation === true);
  const resultReceived = first(byType("execution.result.received").map(eventEpoch));
  const terminal = last(events.filter((event) => ["task.integrated", "task.failed", "task.blocked", "task.cancelled", "task.verified"].includes(event.event_type)).map(eventEpoch));
  const executorCompletedPayload = byType("executor.completed").map(payload).at(-1) ?? {};
  const resultPayload = byType("execution.result.received").map(payload).at(-1) ?? {};
  const executorStartedAt = epoch(executorCompletedPayload.startedAt ?? resultPayload.startedAt);
  const executorCompletedAt = epoch(executorCompletedPayload.completedAt ?? resultPayload.completedAt);
  const executorDuration = finite(executorCompletedPayload.durationMs ?? resultPayload.executorDurationMs)
    ?? duration(executorStartedAt ?? executorSpawned, executorCompletedAt ?? executorCompletedEvent);
  const openCodeStart = openCodeLaunching ?? openCodeSpawned;
  const openCodeMs = duration(openCodeStart, openCodeCompleted);
  const executorStart = executorStartedAt ?? executorSpawned;
  const executorEnd = executorCompletedAt ?? executorCompletedEvent;
  const runtimeBeforeOpenCodeMs = duration(executorStart, openCodeStart);
  const runtimeAfterOpenCodeMs = duration(openCodeCompleted, executorEnd);
  const modelToolLoopMs = Number.isFinite(openCodeMs) && Number.isFinite(auxiliaryModelMs)
    ? openCodeMs + auxiliaryModelMs
    : null;
  const runtimeAfterOpenCodeExclusiveMs = Number.isFinite(runtimeAfterOpenCodeMs) && Number.isFinite(auxiliaryModelMs)
    ? Math.max(0, runtimeAfterOpenCodeMs - auxiliaryModelMs)
    : runtimeAfterOpenCodeMs;
  const runtimeWrapperExclusiveMs = Number.isFinite(runtimeBeforeOpenCodeMs) && Number.isFinite(runtimeAfterOpenCodeExclusiveMs)
    ? runtimeBeforeOpenCodeMs + runtimeAfterOpenCodeExclusiveMs
    : null;
  const start = preparationStarted ?? queued ?? running ?? executorStart;
  const end = terminal ?? resultReceived ?? executorCompletedAt ?? executorCompletedEvent;
  const executionMode = executionModeForAttempt(events);
  return {
    attempt,
    executionMode,
    fullAgentInvocation: executionMode !== "deterministic-reuse" && !repairResumeSkippedFullAgent,
    repairResumeSkippedFullAgent,
    phases: {
      preparationMs: duration(preparationStarted, descriptorReady ?? queued),
      queueWaitMs: duration(queued, running),
      workspacePreparationMs: duration(running, workspaceReady ?? executorSpawned),
      executorMs: executorDuration,
      openCodeMs,
      auxiliaryModelMs,
      modelToolLoopMs,
      runtimeBeforeOpenCodeMs,
      runtimeAfterOpenCodeMs,
      runtimeAfterOpenCodeExclusiveMs,
      runtimeWrapperExclusiveMs,
      resultTransferMs: duration(executorEnd, resultReceived),
      finalizationMs: duration(resultReceived, terminal),
      totalWallMs: duration(start, end),
    },
    auxiliary: {
      invocationCount: auxiliaryInvocationCount,
      timingMissingCount: auxiliaryTimingMissingCount,
      invocations: auxiliaryInvocations,
    },
    timestamps: {
      preparationStartedAt: preparationStarted ? new Date(preparationStarted).toISOString() : null,
      descriptorReadyAt: descriptorReady ? new Date(descriptorReady).toISOString() : null,
      queuedAt: queued ? new Date(queued).toISOString() : null,
      runningAt: running ? new Date(running).toISOString() : null,
      workspaceReadyAt: workspaceReady ? new Date(workspaceReady).toISOString() : null,
      executorStartedAt: executorStart ? new Date(executorStart).toISOString() : null,
      openCodeStartedAt: openCodeStart ? new Date(openCodeStart).toISOString() : null,
      openCodeCompletedAt: openCodeCompleted ? new Date(openCodeCompleted).toISOString() : null,
      executorCompletedAt: executorEnd ? new Date(executorEnd).toISOString() : null,
      resultReceivedAt: resultReceived ? new Date(resultReceived).toISOString() : null,
      terminalAt: terminal ? new Date(terminal).toISOString() : null,
    },
  };
}

function criticalPath(tasks, plan) {
  const weights = new Map(tasks.map((task) => [task.taskId, task.totalWallMs ?? 0]));
  const dependencies = new Map((plan?.tasks ?? []).map((task) => [task.taskId, task.dependencies ?? []]));
  const memo = new Map();
  const visiting = new Set();
  const solve = (taskId) => {
    if (memo.has(taskId)) return memo.get(taskId);
    if (visiting.has(taskId)) return { durationMs: 0, path: [] };
    visiting.add(taskId);
    let best = { durationMs: 0, path: [] };
    for (const dependency of dependencies.get(taskId) ?? []) {
      const candidate = solve(dependency);
      if (candidate.durationMs > best.durationMs) best = candidate;
    }
    visiting.delete(taskId);
    const result = { durationMs: best.durationMs + (weights.get(taskId) ?? 0), path: [...best.path, taskId] };
    memo.set(taskId, result);
    return result;
  };
  let best = { durationMs: 0, path: [] };
  for (const task of tasks) {
    const candidate = solve(task.taskId);
    if (candidate.durationMs > best.durationMs) best = candidate;
  }
  return best;
}


function retryEvidence(events = []) {
  const scheduledDetails = new Map(events
    .filter((event) => event?.event_type === "task.retry_scheduled")
    .map((event) => {
      const value = payload(event);
      const key = `${event.task_id ?? ""}|${Math.max(1, finite(value.attempt) ?? 1)}`;
      return [key, value];
    }));
  const scheduled = events.filter((event) => event?.event_type === "retry.true_scheduled").map((event) => {
    const value = payload(event);
    const attempt = Math.max(1, finite(value.attempt) ?? 1);
    const detail = scheduledDetails.get(`${event.task_id ?? ""}|${attempt}`) ?? {};
    return {
      taskId: event.task_id ?? null,
      attempt,
      failureCode: String(value.failureCode ?? "execution_failed"),
      failureCategory: String(value.failureCategory ?? detail.failureCategory ?? detail.category ?? "unknown"),
      failureMessage: String(value.failureMessage ?? detail.failureMessage ?? detail.message ?? "").slice(0, 4_000),
      disposition: String(value.retryDisposition ?? "unclassified"),
      retryAfterMs: Math.max(0, finite(value.retryAfterMs) ?? 0),
      repairExhausted: value.repairExhausted === true,
      createdAt: event.created_at ?? null,
    };
  });
  const byDisposition = (name) => scheduled.filter((item) => item.disposition === name);
  const known = new Set(["true-retry-semantic", "true-retry-transient", "true-retry-repair-exhausted"]);
  return {
    scheduled,
    semantic: byDisposition("true-retry-semantic"),
    transient: byDisposition("true-retry-transient"),
    repairExhausted: scheduled.filter((item) => item.disposition === "true-retry-repair-exhausted" || item.repairExhausted),
    unclassified: scheduled.filter((item) => !known.has(item.disposition)),
  };
}

function qualification({ run, tasks, summary, execution, slo, requireDeterministicReuse }) {
  const failures = [];
  const incomplete = [];
  if (!run?.completed_at || !run?.started_at) incomplete.push("run_wall_time_unavailable");
  if (run?.status && run.status !== "closed") failures.push(`run_status_not_closed:${run.status}`);
  if (summary.taskWall.count !== tasks.length) incomplete.push(`task_wall_time_partial:${summary.taskWall.count}/${tasks.length}`);
  if (execution.fullAgentTimingMissingCount > 0) incomplete.push(`opencode_timing_missing:${execution.fullAgentTimingMissingCount}`);
  if (execution.auxiliaryTimingMissingCount > 0) incomplete.push(`auxiliary_model_timing_missing:${execution.auxiliaryTimingMissingCount}`);
  if (summary.runWallMs !== null && summary.runWallMs > slo.normalRunWallMs) failures.push(`run_wall_exceeded:${summary.runWallMs}>${slo.normalRunWallMs}`);
  if (summary.taskWall.maxMs !== null && summary.taskWall.maxMs > slo.maxTaskWallMs) failures.push(`max_task_wall_exceeded:${summary.taskWall.maxMs}>${slo.maxTaskWallMs}`);
  if (summary.taskWall.p95Ms !== null && summary.taskWall.p95Ms > slo.p95TaskWallMs) failures.push(`p95_task_wall_exceeded:${summary.taskWall.p95Ms}>${slo.p95TaskWallMs}`);
  if (summary.queueWait.p95Ms !== null && summary.queueWait.p95Ms > slo.p95QueueWaitMs) failures.push(`p95_queue_wait_exceeded:${summary.queueWait.p95Ms}>${slo.p95QueueWaitMs}`);
  if (summary.preparation.p95Ms !== null && summary.preparation.p95Ms > slo.p95PreparationMs) failures.push(`p95_preparation_exceeded:${summary.preparation.p95Ms}>${slo.p95PreparationMs}`);
  if (summary.finalization.p95Ms !== null && summary.finalization.p95Ms > slo.p95FinalizationMs) failures.push(`p95_finalization_exceeded:${summary.finalization.p95Ms}>${slo.p95FinalizationMs}`);
  if (slo.requireZeroRetries && execution.retryAttemptCount > 0) failures.push(`retry_attempts_observed:${execution.retryAttemptCount}`);
  if (slo.requireZeroTransientRetries && execution.transientRetryCount > 0) failures.push(`transient_retries_observed:${execution.transientRetryCount}`);
  if (slo.requireZeroRepairExhaustedRetries && execution.repairExhaustedRetryCount > 0) failures.push(`repair_exhausted_retries_observed:${execution.repairExhaustedRetryCount}`);
  if (slo.requireZeroUnclassifiedRetries && execution.unclassifiedRetryCount > 0) failures.push(`unclassified_retries_observed:${execution.unclassifiedRetryCount}`);
  if (Number.isFinite(slo.maxSemanticRetries) && execution.semanticRetryCount > slo.maxSemanticRetries) failures.push(`semantic_retries_exceeded:${execution.semanticRetryCount}>${slo.maxSemanticRetries}`);
  if (Number.isFinite(slo.maxAttemptsPerTask) && execution.maxAttemptsPerTask > slo.maxAttemptsPerTask) failures.push(`max_attempts_per_task_exceeded:${execution.maxAttemptsPerTask}>${slo.maxAttemptsPerTask}`);
  if (Number.isFinite(slo.maxRetryWallShareOfRun) && Number.isFinite(execution.retryWallShareOfRun) && execution.retryWallShareOfRun > slo.maxRetryWallShareOfRun) failures.push(`retry_wall_share_exceeded:${execution.retryWallShareOfRun.toFixed(4)}>${slo.maxRetryWallShareOfRun}`);
  if (requireDeterministicReuse && execution.deterministicReuseAttemptCount < 1) failures.push("deterministic_reuse_not_exercised");
  if (summary.parallelOpportunity >= slo.parallelOpportunityThreshold && summary.observedParallelSpeedup !== null && summary.observedParallelSpeedup < slo.minParallelSpeedupWhenOpportunity) {
    failures.push(`parallel_speedup_below_target:${summary.observedParallelSpeedup.toFixed(3)}<${slo.minParallelSpeedupWhenOpportunity}`);
  }
  const verdict = incomplete.length > 0 ? "INCOMPLETE" : failures.length > 0 ? "HOLD" : "PASS";
  return { verdict, failures, incomplete, slo };
}

export function summarizeRuntimePerformance({ run, tasks, events, plan = null, slo = DEFAULT_RUNTIME_PERFORMANCE_SLO, requireDeterministicReuse = false } = {}) {
  const taskById = new Map((tasks ?? []).map((task) => [task.task_id, task]));
  const eventsByTaskAttempt = new Map();
  for (const event of events ?? []) {
    if (!event.task_id || !taskById.has(event.task_id)) continue;
    const attempt = attemptIdentity(event, taskById.get(event.task_id));
    const key = `${event.task_id}:${attempt}`;
    const list = eventsByTaskAttempt.get(key) ?? [];
    list.push(event);
    eventsByTaskAttempt.set(key, list);
  }
  const attemptReports = [];
  for (const [key, attemptEvents] of eventsByTaskAttempt) {
    const split = key.lastIndexOf(":");
    const taskId = key.slice(0, split);
    const attempt = Number(key.slice(split + 1));
    attemptReports.push({ taskId, agentId: taskById.get(taskId)?.agent_id ?? null, ...buildAttemptReport(taskById.get(taskId), attempt, attemptEvents) });
  }
  attemptReports.sort((a, b) => `${a.taskId}:${a.attempt}`.localeCompare(`${b.taskId}:${b.attempt}`));
  const attemptsByTask = new Map();
  for (const attempt of attemptReports) {
    const list = attemptsByTask.get(attempt.taskId) ?? [];
    list.push(attempt);
    attemptsByTask.set(attempt.taskId, list);
  }
  const taskReports = (tasks ?? []).map((task) => {
    const attempts = attemptsByTask.get(task.task_id) ?? [];
    const totalWallMs = attempts.length > 0 && attempts.every((item) => Number.isFinite(item.phases.totalWallMs))
      ? attempts.reduce((sum, item) => sum + item.phases.totalWallMs, 0)
      : (finite(task.duration_ms) ?? null);
    return {
      taskId: task.task_id,
      agentId: task.agent_id,
      status: task.status,
      attempts: attempts.length,
      totalWallMs,
      executionModes: [...new Set(attempts.map((item) => item.executionMode))],
      attemptReports: attempts,
    };
  });
  const wallValues = taskReports.map((task) => task.totalWallMs).filter(Number.isFinite);
  const prepValues = attemptReports.map((item) => item.phases.preparationMs).filter(Number.isFinite);
  const queueValues = attemptReports.map((item) => item.phases.queueWaitMs).filter(Number.isFinite);
  const workspaceValues = attemptReports.map((item) => item.phases.workspacePreparationMs).filter(Number.isFinite);
  const executorValues = attemptReports.map((item) => item.phases.executorMs).filter(Number.isFinite);
  const openCodeValues = attemptReports.map((item) => item.phases.openCodeMs).filter(Number.isFinite);
  const auxiliaryModelValues = attemptReports.map((item) => item.phases.auxiliaryModelMs).filter((value, index) => attemptReports[index].auxiliary.invocationCount > 0 && Number.isFinite(value));
  const modelToolLoopValues = attemptReports.map((item) => item.phases.modelToolLoopMs).filter(Number.isFinite);
  const runtimeBeforeOpenCodeValues = attemptReports.map((item) => item.phases.runtimeBeforeOpenCodeMs).filter(Number.isFinite);
  const runtimeAfterOpenCodeValues = attemptReports.map((item) => item.phases.runtimeAfterOpenCodeMs).filter(Number.isFinite);
  const runtimeAfterOpenCodeExclusiveValues = attemptReports.map((item) => item.phases.runtimeAfterOpenCodeExclusiveMs).filter(Number.isFinite);
  const runtimeWrapperExclusiveValues = attemptReports.map((item) => item.phases.runtimeWrapperExclusiveMs).filter(Number.isFinite);
  const transferValues = attemptReports.map((item) => item.phases.resultTransferMs).filter(Number.isFinite);
  const finalizationValues = attemptReports.map((item) => item.phases.finalizationMs).filter(Number.isFinite);
  const runWallMs = duration(epoch(run?.started_at), epoch(run?.completed_at));
  const serializedTaskMs = wallValues.reduce((sum, value) => sum + value, 0);
  let parsedPlan = plan;
  if (!parsedPlan && run?.plan_json) {
    try { parsedPlan = JSON.parse(run.plan_json); } catch { parsedPlan = null; }
  }
  const critical = criticalPath(taskReports, parsedPlan);
  const observedParallelSpeedup = runWallMs && runWallMs > 0 ? serializedTaskMs / runWallMs : null;
  const parallelOpportunity = critical.durationMs > 0 ? serializedTaskMs / critical.durationMs : 1;
  const summary = {
    runWallMs,
    serializedTaskMs,
    criticalPathMs: critical.durationMs || null,
    criticalPathTaskIds: critical.path,
    parallelOpportunity,
    observedParallelSpeedup,
    criticalPathUtilization: runWallMs && runWallMs > 0 && critical.durationMs > 0 ? critical.durationMs / runWallMs : null,
    taskWall: phaseSummary(wallValues),
    preparation: phaseSummary(prepValues),
    queueWait: phaseSummary(queueValues),
    workspacePreparation: phaseSummary(workspaceValues),
    executor: phaseSummary(executorValues),
    openCode: phaseSummary(openCodeValues),
    auxiliaryModel: phaseSummary(auxiliaryModelValues),
    modelToolLoop: phaseSummary(modelToolLoopValues),
    runtimeBeforeOpenCode: phaseSummary(runtimeBeforeOpenCodeValues),
    runtimeAfterOpenCode: phaseSummary(runtimeAfterOpenCodeValues),
    runtimeAfterOpenCodeExclusive: phaseSummary(runtimeAfterOpenCodeExclusiveValues),
    runtimeWrapperExclusive: phaseSummary(runtimeWrapperExclusiveValues),
    openCodeShareOfExecutor: executorValues.length > 0 && openCodeValues.length > 0
      ? openCodeValues.reduce((sum, value) => sum + value, 0) / executorValues.reduce((sum, value) => sum + value, 0)
      : null,
    modelToolLoopShareOfExecutor: executorValues.length > 0 && modelToolLoopValues.length > 0
      ? modelToolLoopValues.reduce((sum, value) => sum + value, 0) / executorValues.reduce((sum, value) => sum + value, 0)
      : null,
    resultTransfer: phaseSummary(transferValues),
    finalization: phaseSummary(finalizationValues),
  };
  const retry = retryEvidence(events);
  const retryAttemptReports = attemptReports.filter((item) => item.attempt > 1);
  const retryWallMs = retryAttemptReports.every((item) => Number.isFinite(item.phases.totalWallMs))
    ? retryAttemptReports.reduce((sum, item) => sum + item.phases.totalWallMs, 0)
    : null;
  const execution = {
    semanticAttemptCount: attemptReports.length,
    fullAgentAttemptCount: attemptReports.filter((item) => item.fullAgentInvocation).length,
    deterministicReuseAttemptCount: attemptReports.filter((item) => item.executionMode === "deterministic-reuse").length,
    repairResumeWithoutAgentInvocationCount: attemptReports.filter((item) => item.repairResumeSkippedFullAgent).length,
    openCodeInvocationCount: attemptReports.filter((item) => Number.isFinite(item.phases.openCodeMs)).length,
    auxiliaryModelInvocationCount: attemptReports.reduce((sum, item) => sum + item.auxiliary.invocationCount, 0),
    modelInvocationCount: attemptReports.filter((item) => Number.isFinite(item.phases.openCodeMs)).length + attemptReports.reduce((sum, item) => sum + item.auxiliary.invocationCount, 0),
    fullAgentTimingMissingCount: attemptReports.filter((item) => item.fullAgentInvocation && !Number.isFinite(item.phases.openCodeMs)).length,
    auxiliaryTimingMissingCount: attemptReports.reduce((sum, item) => sum + item.auxiliary.timingMissingCount, 0),
    // Backward-compatible physical semantic-attempt count.
    retryAttemptCount: retryAttemptReports.length,
    retryScheduledCount: retry.scheduled.length,
    semanticRetryCount: retry.semantic.length,
    transientRetryCount: retry.transient.length,
    repairExhaustedRetryCount: retry.repairExhausted.length,
    unclassifiedRetryCount: retry.unclassified.length,
    maxAttemptsPerTask: taskReports.reduce((max, task) => Math.max(max, task.attempts), 0),
    retryWallMs,
    retryWallShareOfRun: Number.isFinite(retryWallMs) && Number.isFinite(runWallMs) && runWallMs > 0 ? retryWallMs / runWallMs : null,
    retryEvidence: retry.scheduled,
    terminalTaskCount: (tasks ?? []).filter((task) => TERMINAL_TASK_STATUSES.has(task.status)).length,
  };
  const slowestTasks = [...taskReports]
    .filter((task) => Number.isFinite(task.totalWallMs))
    .sort((a, b) => b.totalWallMs - a.totalWallMs)
    .slice(0, 3)
    .map((task) => ({
      taskId: task.taskId,
      agentId: task.agentId,
      totalWallMs: task.totalWallMs,
      attempts: task.attemptReports.map((attempt) => ({ attempt: attempt.attempt, executionMode: attempt.executionMode, phases: attempt.phases })),
    }));
  return {
    contractVersion: "runtime-performance/v1",
    summary,
    execution,
    qualification: qualification({ run, tasks: taskReports, summary, execution, slo, requireDeterministicReuse }),
    slowestTasks,
    tasks: taskReports,
  };
}
