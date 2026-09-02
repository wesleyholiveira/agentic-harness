export const TERMINAL_RUN_STATUSES = Object.freeze(new Set(["closed", "failed", "blocked", "cancelled"]));
export const ACTIVE_RUN_STATUSES = Object.freeze(new Set(["routed", "running"]));

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(String(status ?? ""));
}

export function isActiveRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(String(status ?? ""));
}

export function assertTerminalRunPatch(current, patch = {}) {
  if (!current || !isTerminalRunStatus(current.status)) return;
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    const nextStatus = patch.status ?? null;
    if (nextStatus !== current.status) {
      const error = new Error(`agent_run_terminal_transition_forbidden:${current.run_id}:${current.status}->${nextStatus ?? "null"}`);
      error.code = "agent_run_terminal_transition_forbidden";
      throw error;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "completed_at")) {
    const nextCompletedAt = patch.completed_at ?? null;
    const currentCompletedAt = current.completed_at ?? null;
    if (nextCompletedAt !== currentCompletedAt) {
      const error = new Error(`agent_run_terminal_occurrence_mutation_forbidden:${current.run_id}`);
      error.code = "agent_run_terminal_occurrence_mutation_forbidden";
      throw error;
    }
  }
}
