export function qualificationBehaviorCommandSpecIds({ taskPlan, brief, attempt, env = process.env } = {}) {
  const boundary = String(env.AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_BOUNDARY ?? "").trim();
  if (boundary !== "repair-checkpoint-before-behavior") return [];

  const commandId = String(env.AGENT_HARNESS_RUNTIME_TEST_BEHAVIOR_COMMAND_ID ?? "").trim();
  if (!commandId || !/^qualification\.[A-Za-z0-9._-]+$/u.test(commandId)) {
    throw new Error("qualification_behavior_command_id_invalid");
  }

  const taskMatch = String(env.AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_TASK_MATCH ?? "").trim();
  if (taskMatch) {
    const identities = [
      taskPlan?.taskId,
      taskPlan?.stage,
      taskPlan?.agentId,
      brief?.taskId,
      brief?.sdd?.stage,
      brief?.agentId,
    ].filter(Boolean).map(String);
    if (!identities.some(value => value === taskMatch || value.includes(taskMatch))) return [];
  }

  const attemptMatch = String(env.AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_ATTEMPT ?? "").trim();
  if (attemptMatch) {
    const expectedAttempt = Number(attemptMatch);
    const actualAttempt = Number(attempt ?? brief?.modelRouting?.attempt ?? 1);
    if (!Number.isInteger(expectedAttempt) || expectedAttempt < 1) {
      throw new Error("qualification_behavior_attempt_invalid");
    }
    if (actualAttempt !== expectedAttempt) return [];
  }

  return [commandId];
}
