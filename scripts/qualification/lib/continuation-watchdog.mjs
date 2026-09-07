export const DEFAULT_CONTINUATION_COMPLETION_TIMEOUT_MS = 900_000;
export const CONTINUATION_COMPLETION_SETTLE_GRACE_MS = 30_000;

const TERMINAL_FAILURE_DELIVERY = new Set(["dead", "ambiguous"]);
const TERMINAL_FAILURE_CONTINUATION = new Set(["manual_review", "cancelled"]);

function epoch(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageMs(value, nowMs) {
  const at = epoch(value);
  return at === null ? null : Math.max(0, nowMs - at);
}

export function summarizeContinuationAssistant(history, messageId) {
  const children = (Array.isArray(history) ? history : [])
    .filter((message) => message?.info?.role === "assistant" && message?.info?.parentID === messageId)
    .sort((left, right) => Number(left?.info?.time?.created ?? 0) - Number(right?.info?.time?.created ?? 0));
  if (children.length === 0) return { state: "missing", messageId: null, count: 0, error: null };
  const latest = children.at(-1);
  const error = latest?.info?.error ?? null;
  const finish = String(latest?.info?.finish ?? "").trim().toLowerCase();
  const followupFinish = new Set(["tool-calls", "tool_calls", "tool-use", "tool_use"]).has(finish);
  const completed = !followupFinish && (Boolean(latest?.info?.time?.completed) || Boolean(finish));
  const toolCalls = children.flatMap((message) => (Array.isArray(message?.parts) ? message.parts : [])
    .filter((part) => part?.type === "tool")
    .map((part) => ({
      messageId: message?.info?.id ?? null,
      callId: part?.callID ?? part?.callId ?? null,
      tool: String(part?.tool ?? part?.name ?? "unknown"),
      status: String(part?.state?.status ?? "unknown"),
      startedAt: part?.state?.time?.start ?? null,
      completedAt: part?.state?.time?.end ?? null,
      error: part?.state?.error ? String(part.state.error).slice(0, 300) : null,
    })))
    .slice(-12);
  const activeToolCalls = toolCalls.filter((call) => ["pending", "running", "executing"].includes(call.status.toLowerCase()));
  return {
    state: error ? "failed" : completed ? "completed" : "pending",
    messageId: latest?.info?.id ?? null,
    count: children.length,
    finish: finish || null,
    createdAt: latest?.info?.time?.created ?? null,
    completedAt: latest?.info?.time?.completed ?? null,
    error,
    toolCalls,
    activeToolCalls,
  };
}

export function evaluateContinuationObservation(observation, {
  nowMs = Date.now(),
  completionTimeoutMs = DEFAULT_CONTINUATION_COMPLETION_TIMEOUT_MS,
  acceptanceStallTimeoutMs = completionTimeoutMs,
  settleGraceMs = CONTINUATION_COMPLETION_SETTLE_GRACE_MS,
  watchStartedAtMs = null,
} = {}) {
  const delivery = observation?.delivery ?? null;
  const continuation = observation?.continuation ?? null;
  if (!delivery) {
    if (Number.isFinite(Number(watchStartedAtMs)) && nowMs - Number(watchStartedAtMs) > Number(acceptanceStallTimeoutMs)) {
      return {
        terminal: null,
        violation: {
          message: "continuation_delivery_materialization_stalled",
          evidence: { ...(observation ?? {}), acceptanceStallTimeoutMs: Number(acceptanceStallTimeoutMs) },
        },
      };
    }
    return { terminal: null, violation: null };
  }

  const requiredShapeValid = Boolean(
    String(delivery.deliveryId ?? "").trim()
    && String(delivery.effectKey ?? "").trim()
    && String(delivery.messageId ?? "").trim()
    && typeof delivery.promptText === "string"
    && String(delivery.status ?? "").trim()
    && String(delivery.createdAt ?? "").trim()
    && Number.isFinite(Number(delivery.generation))
    && Number.isFinite(Number(delivery.attempts))
    && String(continuation?.status ?? "").trim()
  );
  if (!requiredShapeValid) {
    return {
      terminal: null,
      violation: {
        classification: "QUALIFICATION PROCEDURE",
        message: "continuation_observation_shape_invalid",
        evidence: observation,
      },
    };
  }

  const status = String(delivery.status ?? "").trim().toLowerCase();
  const continuationStatus = String(continuation?.status ?? "").trim().toLowerCase();
  if (TERMINAL_FAILURE_DELIVERY.has(status) || TERMINAL_FAILURE_CONTINUATION.has(continuationStatus)) {
    return {
      terminal: null,
      violation: {
        message: "continuation_delivery_terminal_failure",
        evidence: observation,
      },
    };
  }

  const acceptedAtMs = epoch(delivery.acceptedAt);
  const observedAtMs = epoch(delivery.observedAt);
  if (observedAtMs !== null) {
    if (acceptedAtMs === null) {
      return {
        terminal: null,
        violation: { message: "continuation_observed_without_acceptance", evidence: observation },
      };
    }
    if (observedAtMs < acceptedAtMs) {
      return {
        terminal: null,
        violation: { message: "continuation_observed_before_accepted", evidence: observation },
      };
    }
    return { terminal: { delivery }, violation: null };
  }

  if (acceptedAtMs !== null) {
    const dispatchAtMs = epoch(delivery.dispatchStartedAt) ?? acceptedAtMs;
    const completionDeadlineMs = dispatchAtMs + Number(completionTimeoutMs) + Number(settleGraceMs);
    if (nowMs > completionDeadlineMs) {
      return {
        terminal: null,
        violation: {
          message: "continuation_completion_deadline_exceeded_without_runtime_terminal_disposition",
          evidence: {
            ...observation,
            completionTimeoutMs: Number(completionTimeoutMs),
            completionDeadlineAt: new Date(completionDeadlineMs).toISOString(),
          },
        },
      };
    }
    return { terminal: null, violation: null };
  }

  const createdAtMs = epoch(delivery.createdAt);
  if (createdAtMs !== null && nowMs - createdAtMs > Number(acceptanceStallTimeoutMs)) {
    return {
      terminal: null,
      violation: {
        message: "continuation_acceptance_stalled",
        evidence: {
          ...observation,
          acceptanceStallTimeoutMs: Number(acceptanceStallTimeoutMs),
          deliveryAgeMs: nowMs - createdAtMs,
        },
      },
    };
  }

  return { terminal: null, violation: null };
}

function compactDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return null;
  const value = Math.max(0, Number(ms));
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

export function formatContinuationProgress(observation, { nowMs = Date.now() } = {}) {
  const delivery = observation?.delivery ?? {};
  const assistant = observation?.assistant ?? {};
  const attempts = Number(delivery.attempts);
  const values = [
    `delivery=${delivery.status ?? (observation?.delivery ? "unknown" : "missing")}`,
    `attempts=${Number.isFinite(attempts) ? attempts : "?"}`,
  ];
  const age = ageMs(delivery.createdAt, nowMs);
  const acceptedAge = ageMs(delivery.acceptedAt, nowMs);
  if (age !== null) values.push(`age=${compactDuration(age)}`);
  if (acceptedAge !== null) values.push(`acceptedAge=${compactDuration(acceptedAge)}`);
  if (observation?.sessionStatus) values.push(`session=${observation.sessionStatus}`);
  if (Number.isFinite(Number(observation?.wakeCount))) values.push(`wakeCount=${Number(observation.wakeCount)}`);
  if (assistant?.state) values.push(`assistant=${assistant.state}`);
  if (assistant?.finish) values.push(`finish=${assistant.finish}`);
  const activeTool = Array.isArray(assistant?.activeToolCalls) ? assistant.activeToolCalls.at(-1) : null;
  const latestTool = Array.isArray(assistant?.toolCalls) ? assistant.toolCalls.at(-1) : null;
  if (activeTool) values.push(`tool=${activeTool.tool}:${activeTool.status}`);
  else if (latestTool) values.push(`lastTool=${latestTool.tool}:${latestTool.status}`);
  if (assistant?.messageId) values.push(`assistantId=${assistant.messageId}`);
  if (delivery.lastError) values.push(`lastError=${String(delivery.lastError).slice(0, 120)}`);
  return values.join(" ");
}
