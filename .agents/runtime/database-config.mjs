import { existsSync, readFileSync as nodeReadFileSync } from "node:fs";

function directOrFile(environment, valueName, fileName, readFileSync) {
  const direct = String(environment[valueName] ?? "").trim();
  if (direct) return direct;
  const filePath = String(environment[fileName] ?? "").trim();
  if (!filePath) return null;
  let value;
  try {
    value = String(readFileSync(filePath, "utf8")).trim();
  } catch {
    throw new Error(`${fileName.toLowerCase()}_unreadable`);
  }
  if (!value) throw new Error(`${fileName.toLowerCase()}_empty`);
  return value;
}

function assertAliasesMatch(values, errorCode) {
  const configured = values.filter(Boolean);
  if (configured.length > 1 && configured.some((value) => value !== configured[0])) {
    throw new Error(errorCode);
  }
}

function resolveAliasReference(value, targetName, targetValue, errorCode) {
  if (value !== `\${${targetName}}`) return value;
  if (!targetValue) throw new Error(errorCode);
  return targetValue;
}

function isContainerRuntime(environment, exists = existsSync, explicitMode = null) {
  const mode = String(explicitMode ?? environment.AGENT_HARNESS_AGENT_DATABASE_NETWORK_MODE ?? "auto").trim().toLowerCase();
  if (mode === "container") return true;
  if (mode === "host") return false;
  if (mode !== "auto" && mode !== "") throw new Error(`invalid_agent_database_network_mode:${mode}`);
  return Boolean(environment.KUBERNETES_SERVICE_HOST) || exists("/.dockerenv");
}

function rewriteComposeDatabaseHostForHost(url, environment, options = {}) {
  if (!url || isContainerRuntime(environment, options.existsSync ?? existsSync, options.networkMode ?? null)) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const composeHost = String(environment.AGENT_HARNESS_AGENT_COMPOSE_DATABASE_HOST ?? "postgres").trim() || "postgres";
  if (parsed.hostname !== composeHost) return url;
  parsed.hostname = String(environment.AGENT_HARNESS_AGENT_HOST_DATABASE_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  if (!parsed.port) {
    parsed.port = String(environment.AGENT_HARNESS_AGENT_HOST_DATABASE_PORT ?? "5432").trim() || "5432";
  }
  return parsed.toString();
}

/**
 * Resolve the PostgreSQL endpoint used by the Agent Runtime.
 *
 * DATABASE_APP_URL remains the canonical product/container credential. The
 * Agent Runtime is often hosted by OpenCode on the developer machine, where a
 * Compose service name such as `postgres` is not DNS-resolvable. An explicit
 * AGENT_HARNESS_AGENT_DATABASE_URL/AGENT_POSTGRES_URL therefore has precedence
 * and is intentionally allowed to use a different host while keeping the same
 * application-role credentials. When no agent-specific URL is configured, a
 * local host-side runtime rewrites only the known Compose service hostname to
 * the published loopback endpoint; container runtimes keep the service name.
 */
export function resolveDatabaseAppUrl(
  environment = process.env,
  { readFileSync = nodeReadFileSync, existsSync: exists = existsSync, networkMode = null } = {},
) {
  const canonical = directOrFile(environment, "DATABASE_APP_URL", "DATABASE_APP_URL_FILE", readFileSync);
  const compatibility = resolveAliasReference(
    directOrFile(environment, "DATABASE_URL", "DATABASE_URL_FILE", readFileSync),
    "DATABASE_APP_URL",
    canonical,
    "database_app_url_alias_unresolved",
  );
  assertAliasesMatch([canonical, compatibility], "database_app_url_alias_mismatch");
  const appUrl = canonical ?? compatibility;

  const agentOverride = resolveAliasReference(
    directOrFile(
      environment,
      "AGENT_HARNESS_AGENT_DATABASE_URL",
      "AGENT_HARNESS_AGENT_DATABASE_URL_FILE",
      readFileSync,
    ),
    "DATABASE_APP_URL",
    appUrl,
    "agent_database_url_alias_unresolved",
  );
  const postgresCompatibility = resolveAliasReference(
    directOrFile(environment, "AGENT_POSTGRES_URL", "AGENT_POSTGRES_URL_FILE", readFileSync),
    "DATABASE_APP_URL",
    appUrl,
    "agent_database_url_alias_unresolved",
  );
  assertAliasesMatch(
    [agentOverride, postgresCompatibility],
    "agent_database_url_alias_mismatch",
  );

  const explicitAgentUrl = agentOverride ?? postgresCompatibility;
  if (explicitAgentUrl) {
    return rewriteComposeDatabaseHostForHost(explicitAgentUrl, environment, { existsSync: exists, networkMode });
  }
  return rewriteComposeDatabaseHostForHost(appUrl, environment, { existsSync: exists, networkMode });
}
