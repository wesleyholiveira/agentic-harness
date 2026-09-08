import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAgentCatalog } from "./agent-catalog.mjs";
import { loadSchemas } from "./schema-validator.mjs";
import { EXPECTED_OPENCODE_MODELS, EXPECTED_OPENCODE_PROVIDER } from "./opencode-readiness.mjs";
import { workerExecutionCapabilities } from "./worker-capabilities.mjs";
import { OrchestrationStore } from "./store.mjs";
import { exists, readJson } from "./utils.mjs";

import { probeSessionHost } from "./session-host-readiness.mjs";
/**
 * Extracts service names from a compose.yaml content string.
 * Uses a minimal parser that identifies top-level keys under the `services:` block.
 * Skips YAML anchors, extension keys (x-), and merge keys (<<).
 */
export function extractComposeServiceNames(content) {
  const serviceNames = [];
  const lines = content.split("\n");
  let inServices = false;
  for (const line of lines) {
    if (/^services:/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices) {
      // Exit services section on next top-level key (indent 0, not empty/comment)
      if (/^[a-zA-Z]/.test(line) && !/^  /.test(line)) {
        break;
      }
      const match = line.match(/^  ([a-zA-Z][a-zA-Z0-9_-]+):/);
      if (match) {
        const name = match[1];
        if (
          !name.startsWith("x-") &&
          name !== "<<" &&
          !name.startsWith("&") &&
          !name.startsWith("*")
        ) {
          serviceNames.push(name);
        }
      }
    }
  }
  return serviceNames;
}

/**
 * Validates consistency between distributed agent manifests dockerProfile fields,
 * .agents/docker-profiles.json, and compose.yaml.
 *
 * Returns an object with { available, profilesLoaded, agentsWithProfile,
 * agentsWithoutProfile, errors, warnings }.
 *
 * This function does NOT throw on missing docker-profiles.json or compose.yaml;
 * it reports warnings/errors instead.
 */
export async function validateDockerProfiles({ repositoryRoot, registry }) {
  const errors = [];
  const warnings = [];

  const profilesPath = join(repositoryRoot, ".agents", "docker-profiles.json");
  const composePath = join(repositoryRoot, "compose.yaml");

  // Load docker-profiles.json
  let dockerProfilesData = null;
  if (await exists(profilesPath)) {
    try {
      dockerProfilesData = await readJson(profilesPath);
    } catch (error) {
      warnings.push({
        type: "docker_profiles_parse_error",
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        available: false,
        profilesLoaded: 0,
        agentsWithProfile: 0,
        agentsWithoutProfile: [],
        errors,
        warnings,
      };
    }
  } else {
    warnings.push({
      type: "docker_profiles_missing",
      message: ".agents/docker-profiles.json not found",
    });
    return {
      available: false,
      profilesLoaded: 0,
      agentsWithProfile: 0,
      agentsWithoutProfile: [],
      errors,
      warnings,
    };
  }

  // Load compose.yaml services
  let composeServices = [];
  if (await exists(composePath)) {
    try {
      const composeContent = await readFile(composePath, "utf8");
      composeServices = extractComposeServiceNames(composeContent);
    } catch (error) {
      warnings.push({
        type: "compose_parse_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    warnings.push({
      type: "compose_missing",
      message: "compose.yaml not found",
    });
  }

  const profiles = dockerProfilesData?.profiles ?? {};
  const profilesAgents = dockerProfilesData?.agents ?? {};
  const profilesLoaded = Object.keys(profiles).length;

  // Validate profile services against compose.yaml
  if (composeServices.length > 0) {
    for (const [profileName, profileDef] of Object.entries(profiles)) {
      const services = profileDef?.services ?? [];
      for (const service of services) {
        if (!composeServices.includes(service)) {
          errors.push({
            type: "service_not_in_compose",
            profile: profileName,
            service,
            message: `Service "${service}" referenced in profile "${profileName}" not found in compose.yaml`,
          });
        }
      }
    }
  }

  // Validate catalog agents' dockerProfile references
  let agentsWithProfile = 0;
  const agentsWithoutProfile = [];
  const agentIds = new Set(registry.agents.map((a) => a.id));

  for (const agent of registry.agents) {
    if (agent.dockerProfile) {
      agentsWithProfile += 1;
      // Validate the profile exists in docker-profiles.json
      if (!profiles[agent.dockerProfile]) {
        errors.push({
          type: "profile_not_found",
          agent: agent.id,
          profile: agent.dockerProfile,
          message: `Agent "${agent.id}" references dockerProfile "${agent.dockerProfile}" which is not defined in docker-profiles.json`,
        });
      }
      // Validate consistency with docker-profiles.json agents section (if agent is listed there)
      if (profilesAgents[agent.id] && profilesAgents[agent.id].profile !== agent.dockerProfile) {
        warnings.push({
          type: "profile_mismatch",
          agent: agent.id,
          registryProfile: agent.dockerProfile,
          profilesFileProfile: profilesAgents[agent.id].profile,
          message: `Agent "${agent.id}" has dockerProfile "${agent.dockerProfile}" in distributed agent manifests but "${profilesAgents[agent.id].profile}" in docker-profiles.json`,
        });
      }
    } else if (dockerProfilesData) {
      // Agent has no dockerProfile in registry - check if it should
      agentsWithoutProfile.push(agent.id);
      // Only warn for permanent agents that aren't the orchestrator
      // The orchestrator typically doesn't need a profile
      if (agent.id !== registry.orchestrator) {
        warnings.push({
          type: "missing_docker_profile",
          agent: agent.id,
          message: `Agent "${agent.id}" has no dockerProfile declared in distributed agent manifests (defaults to "none")`,
        });
      }
    }
  }

  return {
    available: true,
    profilesLoaded,
    agentsWithProfile,
    agentsWithoutProfile,
    errors,
    warnings,
  };
}



export async function buildDoctorReport({ repositoryRoot, harnessRoot = repositoryRoot, databaseUrl, databaseSchema = "public" }) {
  const [registry, schemas, continuationServer] = await Promise.all([
    loadAgentCatalog(harnessRoot),
    loadSchemas(harnessRoot),
    probeSessionHost({ environment: process.env, networkScope: "container" }),
  ]);
  const expectedModels = EXPECTED_OPENCODE_MODELS;
  let databaseAvailable = false;
  let databaseError = null;
  let databaseErrorCode = null;
  let databaseMissing = [];
  let agentRuntimeWorker = null;
  const agentRuntimeWorkerHeartbeatTimeoutMs = Number(
    process.env.AGENT_HARNESS_RUNTIME_WORKER_HEARTBEAT_TIMEOUT_MS ?? 45_000,
  );
  if (databaseUrl) {
    const store = new OrchestrationStore(databaseUrl, { readOnly: true, schema: databaseSchema });
    try {
      await store.open();
      databaseAvailable = true;
      agentRuntimeWorker = await store.runtimeWorkerHealth(agentRuntimeWorkerHeartbeatTimeoutMs);
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
      databaseErrorCode = error && typeof error === "object" && "code" in error ? String(error.code) : null;
      databaseMissing = error && typeof error === "object" && "missing" in error && Array.isArray(error.missing)
        ? error.missing.map(String)
        : [];
    } finally {
      await store.close().catch(() => {});
    }
  }

  const executionPlane = workerExecutionCapabilities(agentRuntimeWorker, expectedModels);
  const authCatalog = {
    available: executionPlane.authAvailable,
    source: executionPlane.source,
    authPath: executionPlane.authPath,
    expectedProviders: [EXPECTED_OPENCODE_PROVIDER],
    missingProviders: executionPlane.authOpenaiAvailable ? [] : [EXPECTED_OPENCODE_PROVIDER],
    error: executionPlane.available
      ? (executionPlane.authAvailable ? null : "worker_auth_unavailable")
      : "worker_capabilities_unavailable",
  };
  const modelCatalog = {
    available: executionPlane.modelCatalogAvailable,
    provider: EXPECTED_OPENCODE_PROVIDER,
    expectedModels,
    availableModels: executionPlane.openaiModels,
    missingModels: executionPlane.missingModels,
    error: executionPlane.available
      ? (executionPlane.modelCatalogAvailable ? null : "worker_model_catalog_unavailable")
      : "worker_capabilities_unavailable",
  };

  const dockerProfiles = await validateDockerProfiles({ repositoryRoot: harnessRoot, registry });
  const retiredMcpTombstone = "scripts/agent-mcp-server.mjs";
  const forbiddenLegacyArtifacts = [
    "scripts/context-engine-task-context.ts",
    ".agents/runtime/langgraph-engine.mjs",
    ".agents/runtime/langgraph-engine.test.ts",
    ".agents/runtime/legacy-engine.mjs",
  ];
  const legacyArtifactsPresent = [];
  if (await exists(join(repositoryRoot, retiredMcpTombstone))) {
    try {
      const content = await readFile(join(repositoryRoot, retiredMcpTombstone), "utf8");
      if (!content.includes("RETIRED_AGENT_RUNTIME_MCP_TOMBSTONE")) legacyArtifactsPresent.push(retiredMcpTombstone);
    } catch {
      legacyArtifactsPresent.push(retiredMcpTombstone);
    }
  }
  for (const relativePath of forbiddenLegacyArtifacts) {
    if (await exists(join(repositoryRoot, relativePath))) legacyArtifactsPresent.push(relativePath);
  }

  const executorConfigured = Boolean(process.env.AGENT_HARNESS_AGENT_EXECUTOR_COMMAND) || executionPlane.opencodeAvailable;
  const failures = [];
  if (!executionPlane.available) failures.push("execution_plane_capabilities_unavailable");
  else if (!executionPlane.gitAvailable) failures.push("git_unavailable");
  if (!databaseUrl) failures.push("database_not_configured");
  else if (!databaseAvailable) failures.push(`database_unavailable:${databaseError ?? "unknown"}`);
  if (!executorConfigured) failures.push("executor_unavailable");
  const agentRuntimeWorkerRequired = !["0", "false", "no", "off"].includes(
    String(process.env.AGENT_HARNESS_RUNTIME_WORKER_REQUIRED ?? "true").toLowerCase(),
  );
  if (agentRuntimeWorkerRequired && databaseAvailable && !agentRuntimeWorker?.healthy) {
    failures.push(`agent_runtime_worker_unavailable:${agentRuntimeWorker?.reason ?? `heartbeat_age_ms:${agentRuntimeWorker?.ageMs ?? "unknown"}`}`);
  }
  if (continuationServer.required && !continuationServer.configured) failures.push("agent_continuation_server_not_configured");
  else if (continuationServer.required && !continuationServer.healthy) failures.push(`agent_continuation_server_unavailable:${continuationServer.error ?? "unknown"}`);
  if (!process.env.AGENT_HARNESS_AGENT_EXECUTOR_COMMAND) {
    if (!executionPlane.opencodeAvailable) failures.push("opencode_unavailable");
    else if (!authCatalog?.available) failures.push(`opencode_auth_catalog_unavailable:${authCatalog?.error ?? "unknown"}`);
    else if ((authCatalog.missingProviders ?? []).length > 0) failures.push(`opencode_auth_missing:${authCatalog.missingProviders.join(",")}`);
    else if (!modelCatalog?.available) failures.push(`opencode_model_catalog_unavailable:${modelCatalog?.error ?? "unknown"}`);
    else if ((modelCatalog.missingModels ?? []).length > 0) failures.push(`opencode_models_missing:${modelCatalog.missingModels.join(",")}`);
  }
  for (const error of dockerProfiles.errors ?? []) failures.push(`docker_profile:${error.type}:${error.agent ?? error.profile ?? error.service ?? "unknown"}`);
  for (const relativePath of legacyArtifactsPresent) failures.push(`legacy_runtime_artifact_present:${relativePath}`);

  let databaseEndpoint = null;
  if (databaseUrl) {
    try {
      const parsedDatabaseUrl = new URL(databaseUrl);
      databaseEndpoint = {
        hostname: parsedDatabaseUrl.hostname,
        port: parsedDatabaseUrl.port || "5432",
        database: parsedDatabaseUrl.pathname.replace(/^\//, ""),
      };
    } catch {
      databaseEndpoint = { hostname: "invalid", port: null, database: null };
    }
  }

  return {
    healthy: failures.length === 0,
    failures,
    repositoryRoot,
    harnessRoot,
    catalogAgents: registry.agents.length,
    orchestrator: registry.orchestrator,
    schemas: Object.keys(schemas),
    databaseBackend: "postgres",
    databaseSchema,
    databaseConfigured: Boolean(databaseUrl),
    databaseAvailable,
    databaseError,
    databaseErrorCode,
    databaseMissing,
    databaseRepair: databaseErrorCode === "schema_not_ready"
      ? {
          required: true,
          reason: "agent_runtime_schema_not_ready",
          command: "node <harness>/bin/harness.mjs migrate",
          note: "Apply the harness-owned forward SQL migrations from infra/postgres/migrations against the configured project database.",
        }
      : null,
    databaseEndpoint,
    legacyArtifactsPresent,
    executorConfigured,
    executorMode: process.env.AGENT_HARNESS_AGENT_EXECUTOR_COMMAND ? "custom" : (executionPlane.opencodeAvailable ? "builtin-opencode" : "unavailable"),
    executionPlaneProbeSource: executionPlane.source,
    executionPlaneCapabilitiesAvailable: executionPlane.available,
    executionPlaneProbeErrors: executionPlane.probeErrors,
    opencodeAvailable: executionPlane.opencodeAvailable,
    opencodeVersion: executionPlane.opencodeVersion,
    opencodeProbe: {
      mode: "worker-heartbeat-capabilities",
      source: executionPlane.source,
      workerId: agentRuntimeWorker?.worker_id ?? null,
      gitVersion: executionPlane.gitVersion,
      authPath: executionPlane.authPath,
      openaiModelCount: executionPlane.openaiModels.length,
    },
    opencodeAuth: authCatalog,
    modelCatalog,
    expectedModels,
    missingModels: modelCatalog?.missingModels ?? expectedModels,
    agentRuntimeWorkerRequired,
    agentRuntimeWorker,
    agentRuntimeWorkerId: agentRuntimeWorker?.worker_id ?? null,
    agentRuntimeWorkerHeartbeatAt: agentRuntimeWorker?.heartbeat_at ?? null,
    agentRuntimeWorkerHeartbeatFresh: Boolean(agentRuntimeWorker?.healthy),
    // This is a bounded-staleness database lease, not Docker/container presence.
    // Gate 0/22 must combine it with the profile's current container state.
    agentRuntimeWorkerLivenessSource: "postgres-heartbeat-lease",
    agentRuntimeWorkerHeartbeatTimeoutMs,
    agentRuntimeWorkerHeartbeatBoundedStaleness: true,
    continuationServer,
    continuationDeliverySemantics: "postgres-inbox-effect-target-message-id",
    continuationTransportGuarantee: "rabbitmq-at-least-once-effectively-once-target-effect",
    reasoningConfigured: Boolean(process.env.AGENT_HARNESS_AGENT_REASONING_COMMAND),
    reasoningMode: process.env.AGENT_HARNESS_AGENT_REASONING_MODE ?? "adaptive",
    gitAvailable: executionPlane.gitAvailable,
    dockerProfiles,
  };
}
