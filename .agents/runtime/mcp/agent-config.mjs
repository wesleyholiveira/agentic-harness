import { resolve } from "node:path";
import { resolveDatabaseAppUrl } from "../database-config.mjs";
import { asBoolean, resolveRepositoryRoot } from "../utils.mjs";
import { AgentMcpError } from "./agent-errors.mjs";

const allowedActionNames = new Set(["status", "summary", "validate", "doctor"]);

export function defaultAgentDatabaseUrl(environment = process.env) {
  return resolveDatabaseAppUrl(environment);
}

export function loadAgentMcpConfig(environment = process.env) {
  if (!asBoolean(environment.AGENT_HARNESS_AGENT_MCP_ENABLED, false)) {
    throw new AgentMcpError("agent_mcp_disabled", "MCP do runtime multiagente está desabilitado.");
  }
  const repositoryRoot = resolveRepositoryRoot(environment.AGENT_HARNESS_REPOSITORY_ROOT ?? process.cwd());
  const databaseUrl = defaultAgentDatabaseUrl(environment);
  if (!databaseUrl) {
    throw new AgentMcpError(
      "database_url_missing",
      "DATABASE_APP_URL ou DATABASE_APP_URL_FILE é obrigatório para o runtime multiagente.",
    );
  }
  const actions = new Set(String(environment.AGENT_HARNESS_AGENT_MCP_ALLOWED_ACTIONS ?? "status,summary,validate,doctor")
    .split(",").map((item) => item.trim()).filter(Boolean));
  for (const action of actions) {
    if (!allowedActionNames.has(action)) throw new AgentMcpError("invalid_allowed_action", `Ação MCP não permitida: ${action}`);
  }
  return {
    repositoryRoot: resolve(repositoryRoot),
    databaseUrl,
    databaseSchema: environment.AGENT_POSTGRES_SCHEMA ?? environment.DATABASE_SCHEMA ?? "public",
    actions,
  };
}
