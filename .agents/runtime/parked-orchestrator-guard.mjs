const TERMINAL_RUN_STATUSES = new Set(["closed", "failed", "blocked", "cancelled"]);
const LIVE_WAKE_STATUSES = new Set(["accepted", "observed"]);

function continuationStillRequiresPark(status) {
  const run = status?.run ?? null;
  const runId = String(run?.runId ?? run?.run_id ?? "").trim();
  if (!runId || !status?.continuation) return false;
  const runStatus = String(run?.status ?? "").trim().toLowerCase();
  const diagnostic = status?.continuation?.diagnostic ?? null;
  const phase = String(diagnostic?.phase ?? "").trim();
  const deliveryStatus = String(diagnostic?.currentDeliveryStatus ?? "").trim().toLowerCase();

  if (!TERMINAL_RUN_STATUSES.has(runStatus)) {
    return phase === "waiting-for-run-terminal";
  }
  if (phase === "wake-materialization-pending") return true;
  if (phase === "wake-delivery-active") return !LIVE_WAKE_STATUSES.has(deliveryStatus);
  return false;
}

export function parkedObservationViolation({ toolName, status } = {}) {
  const run = status?.run ?? null;
  const runId = String(run?.runId ?? run?.run_id ?? "").trim();
  if (!runId || !continuationStillRequiresPark(status)) return null;
  return `agent_runtime_main_orchestrator_parked_observation_denied:${String(toolName ?? "observation")}:${runId}`;
}

export function parkedObservationDisposition({ toolName, status, invocationOrigin } = {}) {
  const violation = parkedObservationViolation({ toolName, status });
  if (!violation) return { action: "allow", violation: null };
  const origin = String(invocationOrigin ?? "unknown").trim() || "unknown";
  if (origin === "explicit-human-turn") return { action: "allow-human", violation: null };
  return { action: "deny", violation };
}
