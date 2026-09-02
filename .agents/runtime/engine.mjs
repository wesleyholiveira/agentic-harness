import { DynamicDagAgentRuntimeEngine } from "./dynamic-dag-engine.mjs";
import { createLLMReasoner } from "./llm-reasoner.mjs";

export function createAgentRuntimeEngine({ llmReasoner = null, policyEngine = null } = {}) {
  return new DynamicDagAgentRuntimeEngine({ llmReasoner: llmReasoner ?? createLLMReasoner(), policyEngine });
}
