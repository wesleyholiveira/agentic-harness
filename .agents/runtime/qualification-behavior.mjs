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

export function qualificationCommandAuthorityFromConfiguration(configuration) {
  if (!configuration
    || configuration.schemaVersion !== "committed-project-configuration/v1"
    || configuration.sourceTrustVerified !== true
    || configuration.policyTrustVerified !== true
    || !configuration.descriptor) {
    throw new Error("qualification_behavior_committed_configuration_invalid");
  }
  const descriptor = configuration.descriptor;
  const authority = {
    schemaVersion: "command-authority/v1",
    projectId: descriptor.projectId,
    repositoryId: descriptor.repositoryId,
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: configuration.sourceSnapshotSha256,
    descriptorDigest: configuration.descriptorDigest,
    policyDigest: configuration.policyDigest,
  };
  if (Object.values(authority).some(value => typeof value !== "string" || !value)) {
    throw new Error("qualification_behavior_command_authority_invalid");
  }
  return authority;
}
