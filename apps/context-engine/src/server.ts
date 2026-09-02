import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentRuntimeControlAdapter } from "./agent-runtime-control.js";
import {
  createContextEngineRuntime,
  type ContextEngineDeps,
  type ContextEngineRuntime,
} from "./runtime-services.js";
import { registerAgentRuntimeTools } from "./tools/agent-runtime.js";
import { registerFindRelated } from "./tools/find-related.js";
import { registerGetArchitecture } from "./tools/get-architecture.js";
import { registerGetDecision } from "./tools/get-decision.js";
import { registerGetFileSummary } from "./tools/get-file-summary.js";
import { registerGetEfficiency } from "./tools/get-efficiency.js";
import { registerGetHealth } from "./tools/get-health.js";
import { registerGetImpact } from "./tools/get-impact.js";
import { registerGetStats } from "./tools/get-stats.js";
import { registerGetSymbol } from "./tools/get-symbol.js";
import { registerGetTaskContext } from "./tools/get-task-context.js";
import { registerResolveContext } from "./tools/resolve-context.js";
import { registerSearchHistory } from "./tools/search-history.js";
import { registerStoreDecision } from "./tools/store-decision.js";
import { Visibility } from "./visibility.js";

export type { ContextEngineDeps } from "./runtime-services.js";

/**
 * Process-scoped Context Engine services.
 *
 * HTTP MCP sessions must create a fresh McpServer/transport per client/session,
 * but they all share this single runtime and Agent Runtime control adapter.
 * That preserves one authoritative cache/memory/context-provider and one
 * semantic Runtime V2 driver per context-engine process.
 */
export interface ContextEngineServices {
  runtime: ContextEngineRuntime;
  startedAt: number;
  agentControl: AgentRuntimeControlAdapter | null;
}

export function createContextEngineServices(
  deps?: Partial<ContextEngineDeps>,
  options: { cwd?: string } = {},
): ContextEngineServices {
  const cwd = options.cwd ?? process.env.AGENT_HARNESS_PROJECT_ROOT?.trim() ?? process.cwd();
  const harnessRoot = process.env.AGENT_HARNESS_ROOT?.trim() || process.cwd();
  const runtime = createContextEngineRuntime(deps, { cwd });
  const agentControl = process.env.AGENT_HARNESS_AGENT_CONTROL_ENABLED !== "false"
    ? new AgentRuntimeControlAdapter(cwd, runtime.contextProvider, harnessRoot)
    : null;
  return { runtime, startedAt: Date.now(), agentControl };
}

export function createContextEngineServerFromServices(services: ContextEngineServices): McpServer {
  const { runtime, startedAt, agentControl } = services;
  const server = new McpServer(
    { name: "agentic-harness-context-engine", version: "1.2.0" },
    { capabilities: { logging: {} } },
  );
  const visibility = new Visibility(server, runtime.stats);

  // Visibility is deliberately on the registration hot path for every tool.
  registerGetTaskContext(visibility, runtime.packBuilder, runtime.referenceStore, runtime.stats);
  registerResolveContext(visibility, runtime.referenceStore);
  registerGetSymbol(visibility, runtime.cbm, runtime.serena);
  registerGetArchitecture(visibility, runtime.cbm);
  registerFindRelated(visibility, runtime.cbm);
  registerGetDecision(visibility, runtime.memory);
  registerStoreDecision(visibility, runtime.memory);
  registerGetFileSummary(visibility, runtime.cbm, runtime.cache);
  registerGetImpact(visibility, runtime.cbm);
  registerSearchHistory(visibility, runtime.memory);
  registerGetHealth(visibility, runtime.cbm, runtime.memory, startedAt, runtime.cbmRuntime, runtime.semanticCache);
  registerGetStats(visibility, runtime.stats, runtime.semanticCache);
  registerGetEfficiency(visibility, runtime.stats, runtime.semanticCache, agentControl);

  // The multi-agent runtime is exposed through this same MCP. HTTP sessions
  // share the same adapter so they cannot create a second semantic driver.
  if (agentControl) registerAgentRuntimeTools(visibility, agentControl);

  return server;
}

export function createContextEngineServer(deps?: Partial<ContextEngineDeps>): McpServer {
  return createContextEngineServerFromServices(createContextEngineServices(deps));
}
