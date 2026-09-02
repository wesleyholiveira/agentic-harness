import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./utils.mjs";
import { validateRegistryAgentTopology } from "./agent-topology.mjs";
import { capabilityCatalogFromRegistry } from "./bootstrap-capabilities.mjs";

async function discoverAgentManifests(repositoryRoot) {
  const root = join(repositoryRoot, ".agents", "agents");
  const entries = await readdir(root, { withFileTypes: true });
  const agents = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name, "agent.json");
    let text;
    try { text = await readFile(path, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const agent = JSON.parse(text);
    if (agent.id !== entry.name) throw new Error(`agent_manifest_directory_identity_mismatch:${entry.name}:${agent.id ?? "missing"}`);
    agents.push(agent);
  }
  if (agents.length === 0) throw new Error("agent_catalog_empty");
  return agents;
}

export async function loadAgentCatalog(repositoryRoot) {
  const [agents, workflow, modelRouting] = await Promise.all([
    discoverAgentManifests(repositoryRoot),
    readJson(join(repositoryRoot, ".agents", "workflow.json")),
    readJson(join(repositoryRoot, ".agents", "model-routing.json")),
  ]);
  const orchestrator = workflow.entryAgent;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  if (!orchestrator || !byId.has(orchestrator)) throw new Error(`agent_catalog_orchestrator_missing:${orchestrator ?? "missing"}`);
  for (const agent of agents) validateRegistryAgentTopology(agent, orchestrator);
  if (modelRouting?.schemaVersion !== 1 || !modelRouting?.classes || !modelRouting?.models) throw new Error("agent_model_routing_catalog_invalid");
  const normalized = { schemaVersion: 2, orchestrator, agents, workflow, modelRouting, byId, authority: ".agents/agents/*/agent.json" };
  capabilityCatalogFromRegistry(normalized);
  return normalized;
}

export function specialists(catalog) { return catalog.agents.filter((agent) => agent.id !== catalog.orchestrator); }
export function agentForPath(catalog, candidate) {
  const normalized = String(candidate ?? "").replaceAll("\\", "/");
  const matches = [];
  for (const agent of specialists(catalog)) {
    for (const pattern of agent.primaryPaths ?? []) {
      const prefix = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
      if (normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized === pattern) matches.push(agent);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
