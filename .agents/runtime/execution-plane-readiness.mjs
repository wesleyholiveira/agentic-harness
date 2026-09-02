export function assertAgentStartWorkerReadiness(worker, { required = true, maxAgeMs = 45_000 } = {}) {
  if (!required) {
    return { required: false, healthy: true, bypassed: true, maxAgeMs };
  }
  if (worker?.healthy === true) {
    return {
      required: true,
      healthy: true,
      bypassed: false,
      workerId: worker.worker_id ?? null,
      heartbeatAt: worker.heartbeat_at ?? null,
      ageMs: Number.isFinite(Number(worker.ageMs)) ? Number(worker.ageMs) : null,
      maxAgeMs,
    };
  }
  const reason = worker?.reason ?? (worker?.available === false
    ? "worker_not_registered"
    : `heartbeat_age_ms:${worker?.ageMs ?? "unknown"}`);
  const error = new Error(`agent_runtime_worker_unavailable:${reason}`);
  error.code = "agent_runtime_worker_unavailable";
  error.retryable = true;
  error.executionPlane = {
    required: true,
    healthy: false,
    workerId: worker?.worker_id ?? null,
    heartbeatAt: worker?.heartbeat_at ?? null,
    ageMs: Number.isFinite(Number(worker?.ageMs)) ? Number(worker.ageMs) : null,
    maxAgeMs,
    reason,
  };
  throw error;
}
