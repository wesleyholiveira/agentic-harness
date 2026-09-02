import { isActiveRunStatus } from "./run-invariants.mjs";

export async function clearActiveAgentRuns({
  store,
  engine,
  keepRunId = null,
  dryRun = false,
  reason = "operator_clear_active_runs",
} = {}) {
  if (!store) throw new Error("agent_runtime_clear_store_required");
  if (!engine) throw new Error("agent_runtime_clear_engine_required");
  const activeRuns = (await store.listRuns(1000)).filter((run) => isActiveRunStatus(run.status));
  if (keepRunId && !activeRuns.some((run) => run.run_id === keepRunId)) {
    throw new Error(`agent_runtime_clear_keep_run_not_active:${keepRunId}`);
  }
  const targets = activeRuns.filter((run) => run.run_id !== keepRunId);
  const preview = {
    schemaVersion: "agent-runtime-active-run-clear/v1",
    dryRun: Boolean(dryRun),
    preservedRunId: keepRunId,
    activeBefore: activeRuns.map((run) => ({ runId: run.run_id, status: run.status, createdAt: run.created_at })),
    targetRunIds: targets.map((run) => run.run_id),
    evidencePreserved: true,
  };
  if (dryRun || targets.length === 0) {
    return { ...preview, cancelled: [], activeAfter: preview.activeBefore };
  }

  const cancelled = [];
  for (const run of targets) {
    const continuation = await store.cancelContinuation(run.run_id, { reason });
    const result = await engine.cancel({ store, runId: run.run_id });
    try { await store.notifyRuntimeWakeup(run.run_id); } catch {}
    cancelled.push({
      runId: run.run_id,
      status: result.status,
      continuationCancelled: Boolean(continuation?.cancelled),
      continuationId: continuation?.continuationId ?? null,
    });
  }

  const activeAfter = (await store.listRuns(1000))
    .filter((run) => isActiveRunStatus(run.status))
    .map((run) => ({ runId: run.run_id, status: run.status, createdAt: run.created_at }));
  return { ...preview, cancelled, activeAfter };
}
