const TERMINAL_RUN_STATUSES = new Set(["closed", "failed", "blocked", "cancelled"]);

export const RUNTIME_WATCHDOG_DEFAULTS = Object.freeze({
  workerStaleMs: 90_000,
  livenessGraceMs: 90_000,
  transitionGraceMs: 180_000,
  postExecutionGraceMs: 300_000,
});

function timestampMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedMs(startedAt, nowMs) {
  const started = timestampMs(startedAt);
  return started === null ? null : Math.max(0, nowMs - started);
}

function ageMs(at, nowMs) {
  const timestamp = timestampMs(at);
  return timestamp === null ? null : Math.max(0, nowMs - timestamp);
}

function number(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function violation(message, evidence = {}) {
  return { message, evidence };
}

function terminalRun(observation) {
  const status = String(observation?.run?.status ?? "");
  if (!TERMINAL_RUN_STATUSES.has(status)) return null;
  return {
    status,
    errorCode: observation?.run?.errorCode ?? "",
    errorMessage: observation?.run?.errorMessage ?? "",
  };
}

export function evaluateRuntimeObservation(
  observation,
  {
    nowMs = Date.now(),
    inactiveSinceMs = null,
    options = RUNTIME_WATCHDOG_DEFAULTS,
  } = {},
) {
  const terminal = terminalRun(observation);
  if (terminal) return { terminal, violation: null, inactiveSinceMs: null };

  const tasks = Array.isArray(observation?.tasks) ? observation.tasks : [];
  const running = tasks.filter((task) => task.status === "running");
  const queued = tasks.filter((task) => task.status === "queued");
  const retrying = tasks.filter((task) => task.status === "retrying");
  const routed = tasks.filter((task) => task.status === "routed");

  if (running.length > 0 || queued.length > 0) {
    const workerAgeMs = ageMs(observation?.worker?.heartbeatAt, nowMs);
    if (workerAgeMs === null || workerAgeMs > options.workerStaleMs) {
      return {
        terminal: null,
        violation: violation("runtime_worker_liveness_lost", {
          worker: observation?.worker ?? null,
          workerHeartbeatAgeMs: workerAgeMs,
          thresholdMs: options.workerStaleMs,
          activeTaskIds: [...running, ...queued].map((task) => task.taskId),
        }),
        inactiveSinceMs: null,
      };
    }
  }

  for (const task of running) {
    const taskElapsedMs = elapsedMs(task.startedAt, nowMs);
    const heartbeatAgeMs = ageMs(task.heartbeat?.at, nowMs);
    const latestEventAgeMs = ageMs(task.latestEvent?.at, nowMs);
    const leaseExpiresAtMs = timestampMs(task.leaseExpiresAt);
    const leaseExpiredByMs = leaseExpiresAtMs === null ? null : Math.max(0, nowMs - leaseExpiresAtMs);
    const hardTimeoutMs = number(task.livenessPolicy?.hardTimeoutMs);
    const softTimeoutMs = number(task.livenessPolicy?.softTimeoutMs);
    const stallTimeoutMs = number(task.livenessPolicy?.stallTimeoutMs);
    const idleMs = number(task.heartbeat?.idleMs);

    if (taskElapsedMs !== null && hardTimeoutMs !== null && taskElapsedMs > hardTimeoutMs + options.livenessGraceMs) {
      return {
        terminal: null,
        violation: violation("runtime_task_exceeded_hard_timeout", {
          taskId: task.taskId,
          stage: task.stage ?? null,
          status: task.status,
          attempt: task.attempt,
          elapsedMs: taskElapsedMs,
          hardTimeoutMs,
          graceMs: options.livenessGraceMs,
          heartbeat: task.heartbeat ?? null,
          latestEvent: task.latestEvent ?? null,
        }),
        inactiveSinceMs: null,
      };
    }

    if (taskElapsedMs !== null && softTimeoutMs !== null && taskElapsedMs > softTimeoutMs + options.livenessGraceMs) {
      return {
        terminal: null,
        violation: violation("runtime_task_exceeded_soft_timeout", {
          taskId: task.taskId,
          stage: task.stage ?? null,
          status: task.status,
          attempt: task.attempt,
          elapsedMs: taskElapsedMs,
          softTimeoutMs,
          graceMs: options.livenessGraceMs,
          heartbeat: task.heartbeat ?? null,
          latestEvent: task.latestEvent ?? null,
        }),
        inactiveSinceMs: null,
      };
    }

    if (idleMs !== null && stallTimeoutMs !== null && idleMs > stallTimeoutMs + options.livenessGraceMs) {
      return {
        terminal: null,
        violation: violation("runtime_task_exceeded_stall_timeout", {
          taskId: task.taskId,
          stage: task.stage ?? null,
          status: task.status,
          attempt: task.attempt,
          idleMs,
          stallTimeoutMs,
          graceMs: options.livenessGraceMs,
          heartbeat: task.heartbeat ?? null,
          latestEvent: task.latestEvent ?? null,
        }),
        inactiveSinceMs: null,
      };
    }

    const executorStillLeased = leaseExpiresAtMs !== null;
    if (
      executorStillLeased
      && leaseExpiredByMs !== null
      && leaseExpiredByMs > options.livenessGraceMs
      && (heartbeatAgeMs === null || heartbeatAgeMs > options.workerStaleMs)
    ) {
      return {
        terminal: null,
        violation: violation("runtime_running_task_execution_lease_expired", {
          taskId: task.taskId,
          stage: task.stage ?? null,
          attempt: task.attempt,
          leaseOwner: task.leaseOwner ?? null,
          leaseExpiresAt: task.leaseExpiresAt ?? null,
          leaseExpiredByMs,
          heartbeatAgeMs,
          heartbeat: task.heartbeat ?? null,
        }),
        inactiveSinceMs: null,
      };
    }

    if (!executorStillLeased && (heartbeatAgeMs === null || heartbeatAgeMs > options.workerStaleMs)) {
      const latestEventType = String(task.latestEvent?.type ?? "");
      const postExecution = latestEventType === "executor.completed"
        || latestEventType.startsWith("completion.")
        || latestEventType.startsWith("workspace.")
        || latestEventType.startsWith("handoff.")
        || latestEventType.startsWith("integration.")
        || latestEventType.startsWith("task.post_execution.");
      if (postExecution && latestEventAgeMs !== null && latestEventAgeMs > options.postExecutionGraceMs) {
        return {
          terminal: null,
          violation: violation("runtime_post_execution_finalization_stalled", {
            taskId: task.taskId,
            stage: task.stage ?? null,
            attempt: task.attempt,
            latestEvent: task.latestEvent ?? null,
            latestEventAgeMs,
            graceMs: options.postExecutionGraceMs,
            pendingExecutionResults: observation?.pendingExecutionResults ?? [],
          }),
          inactiveSinceMs: null,
        };
      }
    }
  }

  if (running.length > 0) return { terminal: null, violation: null, inactiveSinceMs: null };

  if (queued.length > 0) {
    const queuedTimestamps = queued.map((task) => timestampMs(task.queuedAt)).filter((value) => value !== null);
    const oldestQueuedAtMs = queuedTimestamps.length > 0 ? Math.min(...queuedTimestamps) : null;
    const queuedAgeMs = oldestQueuedAtMs === null ? null : Math.max(0, nowMs - oldestQueuedAtMs);
    if (queuedAgeMs !== null && queuedAgeMs > options.transitionGraceMs) {
      return {
        terminal: null,
        violation: violation("runtime_queued_task_not_claimed", {
          queuedTaskIds: queued.map((task) => task.taskId),
          queuedAgeMs,
          graceMs: options.transitionGraceMs,
          worker: observation?.worker ?? null,
          outbox: observation?.outbox ?? [],
        }),
        inactiveSinceMs: null,
      };
    }
    return { terminal: null, violation: null, inactiveSinceMs: null };
  }

  const retryNotBeforeMs = retrying.map((task) => timestampMs(task.retryNotBefore)).filter((value) => value !== null);
  if (retryNotBeforeMs.some((value) => value > nowMs)) {
    return { terminal: null, violation: null, inactiveSinceMs: null };
  }

  const nextInactiveSinceMs = inactiveSinceMs ?? nowMs;
  if (nowMs - nextInactiveSinceMs > options.transitionGraceMs) {
    return {
      terminal: null,
      violation: violation("runtime_scheduler_stalled_without_active_execution", {
        runStatus: observation?.run?.status ?? null,
        inactiveForMs: nowMs - nextInactiveSinceMs,
        graceMs: options.transitionGraceMs,
        routedTaskIds: routed.map((task) => task.taskId),
        retryingTaskIds: retrying.map((task) => task.taskId),
        taskStatuses: tasks.map((task) => ({
          taskId: task.taskId,
          stage: task.stage ?? null,
          status: task.status,
          retryNotBefore: task.retryNotBefore ?? null,
          latestEvent: task.latestEvent ?? null,
        })),
        recentEvents: observation?.recentEvents ?? [],
      }),
      inactiveSinceMs: nextInactiveSinceMs,
    };
  }

  return { terminal: null, violation: null, inactiveSinceMs: nextInactiveSinceMs };
}

function compactDuration(value) {
  const ms = number(value, 0);
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000 * 10) / 10}h`;
}

export function formatRuntimeProgress(observation, nowMs = Date.now()) {
  const tasks = Array.isArray(observation?.tasks) ? observation.tasks : [];
  const counts = new Map();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const current = tasks.find((task) => task.status === "running")
    ?? tasks.find((task) => task.status === "queued")
    ?? tasks.find((task) => task.status === "retrying")
    ?? tasks.find((task) => task.status === "routed")
    ?? null;

  const statusText = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status}=${count}`)
    .join(",");

  if (!current) return `run=${observation?.run?.status ?? "unknown"} tasks=[${statusText || "none"}]`;

  const elapsed = elapsedMs(current.startedAt ?? current.queuedAt, nowMs);
  const heartbeatAge = ageMs(current.heartbeat?.at, nowMs);
  const idleMs = number(current.heartbeat?.idleMs);
  const details = [
    `run=${observation?.run?.status ?? "unknown"}`,
    `tasks=[${statusText}]`,
    `current=${current.stage ?? current.taskId}`,
    `status=${current.status}`,
    `attempt=${current.attempt ?? "?"}/${current.maxAttempts ?? "?"}`,
    current.modelId ? `model=${current.modelId}` : null,
    elapsed !== null ? `elapsed=${compactDuration(elapsed)}` : null,
    heartbeatAge !== null ? `heartbeatAge=${compactDuration(heartbeatAge)}` : null,
    idleMs !== null ? `idle=${compactDuration(idleMs)}` : null,
    current.latestEvent?.type ? `last=${current.latestEvent.type}` : null,
  ].filter(Boolean);

  return details.join(" ");
}
