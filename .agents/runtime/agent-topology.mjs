const ORCHESTRATION_ROLES = new Set(["orchestrator", "specialist"]);
const INTERACTIVE_MODES = new Set(["primary", "subagent"]);
const SESSION_ROLES = new Set(["primary"]);

function assertValue(value, allowed, code, agentId) {
  if (!allowed.has(value)) throw new Error(`${code}:${agentId}:${value ?? "missing"}`);
}

export function validateRegistryAgentTopology(agent, orchestratorId) {
  const agentId = String(agent?.id ?? "unknown");
  assertValue(agent?.orchestrationRole, ORCHESTRATION_ROLES, "agent_orchestration_role_invalid", agentId);
  assertValue(agent?.interactiveMode, INTERACTIVE_MODES, "agent_interactive_mode_invalid", agentId);

  const isOrchestrator = agentId === orchestratorId;
  const expectedOrchestrationRole = isOrchestrator ? "orchestrator" : "specialist";
  const expectedInteractiveMode = isOrchestrator ? "primary" : "subagent";
  if (agent.orchestrationRole !== expectedOrchestrationRole) {
    throw new Error(`agent_orchestration_role_mismatch:${agentId}:${agent.orchestrationRole}:${expectedOrchestrationRole}`);
  }
  if (agent.interactiveMode !== expectedInteractiveMode) {
    throw new Error(`agent_interactive_mode_mismatch:${agentId}:${agent.interactiveMode}:${expectedInteractiveMode}`);
  }
  return agent;
}

export function taskExecutionTopologyForAgent(agent) {
  const agentId = String(agent?.id ?? "unknown");
  assertValue(agent?.orchestrationRole, ORCHESTRATION_ROLES, "agent_orchestration_role_invalid", agentId);
  assertValue(agent?.interactiveMode, INTERACTIVE_MODES, "agent_interactive_mode_invalid", agentId);
  return {
    orchestrationRole: agent.orchestrationRole,
    interactiveMode: agent.interactiveMode,
    // Runtime V2 has already selected the owner. The owner is therefore the
    // top-level agent of this isolated child OpenCode session even when it is
    // a specialist/subagent in the global interactive topology.
    sessionRole: "primary",
  };
}

export function resolveTaskExecutionTopology(brief) {
  const topology = brief?.executionTopology;
  if (!topology) {
    // Compatibility for persisted Task Brief v2 artifacts created before the
    // explicit topology contract. Runtime V2 never delegates a task to the
    // interactive Main Orchestrator, so legacy owner briefs are specialists
    // executed as the primary agent of their isolated session.
    return {
      orchestrationRole: "specialist",
      interactiveMode: "subagent",
      sessionRole: "primary",
      compatibility: "legacy-task-brief-v2",
    };
  }
  const agentId = String(brief?.agentId ?? "unknown");
  assertValue(topology.orchestrationRole, ORCHESTRATION_ROLES, "task_orchestration_role_invalid", agentId);
  assertValue(topology.interactiveMode, INTERACTIVE_MODES, "task_interactive_mode_invalid", agentId);
  assertValue(topology.sessionRole, SESSION_ROLES, "task_session_role_invalid", agentId);
  if (topology.orchestrationRole === "orchestrator" && topology.interactiveMode !== "primary") {
    throw new Error(`task_execution_topology_invalid:${agentId}:orchestrator_requires_primary_interactive_mode`);
  }
  if (topology.orchestrationRole === "specialist" && topology.interactiveMode !== "subagent") {
    throw new Error(`task_execution_topology_invalid:${agentId}:specialist_requires_subagent_interactive_mode`);
  }
  return { ...topology, compatibility: null };
}
