import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { CBMAdapter } from "@agent-harness/cbm-adapter";
import { L1SessionCache, RedisExactCache, TieredContextCache } from "@agent-harness/context-cache";
import {
  ContextPackBuilder,
  ContextReferenceStore,
  type ContextPackBuildContext,
} from "@agent-harness/context-pack";
import { ContextRedisPool } from "@agent-harness/context-redis";
import { Context7Adapter } from "@agent-harness/context7-adapter";
import { ProjectMemory } from "@agent-harness/project-memory";
import { SerenaAdapter } from "@agent-harness/serena-adapter";
import { SummaryManager } from "@agent-harness/summary-manager";
import type { SemanticContextCache } from "@agent-harness/context-semantic-cache";
import { StatsCollector } from "./stats.js";
import { resolveCodebaseMemoryCommand } from "./cbm-command-resolver.js";
import {
  createContextSemanticCache,
  resolveContextSemanticEndpoints,
  type ContextSemanticResolvedConfig,
} from "./semantic-cache-config.js";
import { buildTaskContext, type ContextDeliveryMode } from "./task-context-service.js";

export interface ContextEngineDeps {
  cbm: CBMAdapter;
  memory: ProjectMemory;
  summaryManager: SummaryManager;
  context7: Context7Adapter;
  serena: SerenaAdapter;
  packBuilder: ContextPackBuilder;
  cache: TieredContextCache;
  referenceStore: ContextReferenceStore;
  stats: StatsCollector;
  semanticCache: SemanticContextCache;
}

export interface ContextProviderRequest {
  task: string;
  budgetTokens?: number;
  mode?: ContextDeliveryMode;
  projectId?: string;
  branch?: string;
  role?: string;
  stage?: string;
  schemaVersion?: string;
}

export interface ContextProviderMetrics {
  budgetTokens: number;
  rawTokens: number;
  deliveredTokens: number;
  tokensSaved: number;
  savingsPercent: number;
  cacheHit: boolean;
  cacheTier: "l1" | "l2" | null;
  componentCache: {
    hits: number;
    misses: number;
    hit_sources: string[];
    miss_sources: string[];
  };
  semanticCache: Record<string, unknown> | null;
}

export type ContextProvider = (request: ContextProviderRequest) => Promise<{
  status: "ok";
  packId: string | null;
  cacheStatus: string;
  payload: unknown;
  metrics: ContextProviderMetrics;
}>;

export interface CbmRuntimeDiagnostics {
  binary: string;
  args: string[];
  source: "environment" | "opencode-config" | "path-default";
  configPath?: string;
  project: string;
}

export interface ContextEngineRuntime extends ContextEngineDeps {
  contextProvider: ContextProvider;
  cbmRuntime: CbmRuntimeDiagnostics;
  semanticRuntime: Pick<ContextSemanticResolvedConfig, "networkMode" | "redisUrl" | "redisUrls" | "embeddingBaseUrl" | "embeddingBaseUrls">;
  close(): Promise<void>;
}

function isContainerRuntime(): boolean {
  const configured = (process.env.CONTEXT_ENGINE_PROJECT_MEMORY_DATABASE_NETWORK_MODE ?? "auto").trim().toLowerCase();
  if (configured === "container") return true;
  if (configured === "host") return false;
  if (configured !== "auto" && configured !== "") {
    throw new Error(`context_engine_project_memory_database_network_mode_invalid:${configured}`);
  }
  return Boolean(process.env.KUBERNETES_SERVICE_HOST) || existsSync("/.dockerenv");
}

function rewriteComposeDatabaseHostForHost(url: string | undefined, containerRuntime: boolean): string | undefined {
  if (!url || containerRuntime) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const composeHost = (process.env.AGENT_HARNESS_AGENT_COMPOSE_DATABASE_HOST ?? "postgres").trim() || "postgres";
  if (parsed.hostname !== composeHost) return url;
  parsed.hostname = (process.env.AGENT_HARNESS_AGENT_HOST_DATABASE_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  if (!parsed.port) parsed.port = (process.env.AGENT_HARNESS_AGENT_HOST_DATABASE_PORT ?? "5432").trim() || "5432";
  return parsed.toString();
}

function readOptionalSecretFile(fileKey: string): { value?: string; error?: Error } {
  const file = process.env[fileKey]?.trim();
  if (!file) return {};
  try {
    const value = readFileSync(file, "utf8").trim();
    return value ? { value } : {};
  } catch (error) {
    return { error: new Error(`${fileKey.toLowerCase()}_unreadable`, { cause: error }) };
  }
}

function resolveProjectMemoryConnectionString(): string | undefined {
  const containerRuntime = isContainerRuntime();
  const projectDirect = process.env.CONTEXT_ENGINE_PROJECT_MEMORY_POSTGRES_URL?.trim();
  if (projectDirect) return rewriteComposeDatabaseHostForHost(projectDirect, containerRuntime);

  const projectFile = readOptionalSecretFile("CONTEXT_ENGINE_PROJECT_MEMORY_POSTGRES_URL_FILE");
  if (projectFile.value) return rewriteComposeDatabaseHostForHost(projectFile.value, containerRuntime);

  const appDirect = process.env.DATABASE_APP_URL?.trim();
  if (appDirect) return rewriteComposeDatabaseHostForHost(appDirect, containerRuntime);

  const databaseAlias = process.env.DATABASE_URL?.trim();
  if (databaseAlias && databaseAlias !== "${DATABASE_APP_URL}") {
    return rewriteComposeDatabaseHostForHost(databaseAlias, containerRuntime);
  }

  if (!containerRuntime) {
    const hostFile = process.env.AGENT_HARNESS_DATABASE_APP_URL_HOST_FILE?.trim();
    if (hostFile && hostFile !== "/dev/null") {
      try {
        const value = readFileSync(hostFile, "utf8").trim();
        if (value) return rewriteComposeDatabaseHostForHost(value, false);
      } catch {
        // Fall through to the canonical container/file aliases before failing.
      }
    }
  }

  const appFile = readOptionalSecretFile("DATABASE_APP_URL_FILE");
  if (appFile.value) return rewriteComposeDatabaseHostForHost(appFile.value, containerRuntime);

  const agentCompatibility = process.env.AGENT_POSTGRES_URL?.trim();
  if (agentCompatibility) return rewriteComposeDatabaseHostForHost(agentCompatibility, containerRuntime);

  if (projectFile.error) throw projectFile.error;
  if (appFile.error) throw appFile.error;
  return undefined;
}
function boolEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${key.toLowerCase()}_invalid:${value}`);
}

export function createContextEngineRuntime(
  deps?: Partial<ContextEngineDeps>,
  options: { cwd?: string } = {},
): ContextEngineRuntime {
  const cwd = options.cwd ?? process.cwd();
  const configuredStateDir = process.env.CONTEXT_ENGINE_STATE_DIR ?? ".context-engine";
  const stateDir = isAbsolute(configuredStateDir) ? configuredStateDir : resolve(cwd, configuredStateDir);
  mkdirSync(stateDir, { recursive: true });

  const cbmCommand = resolveCodebaseMemoryCommand(cwd);
  const projectId = process.env.CONTEXT_SEMANTIC_CACHE_PROJECT_ID?.trim()
    || process.env.CODEBASE_MEMORY_PROJECT?.trim()
    || basename(resolve(cwd));
  const cbm = deps?.cbm ?? new CBMAdapter(projectId, cbmCommand.binary, cwd, {
    transport: process.env.CONTEXT_ENGINE_CBM_TRANSPORT === "cli" ? "cli" : "persistent-mcp",
    serverArgs: cbmCommand.args,
  });
  const cbmRuntime: CbmRuntimeDiagnostics = {
    binary: cbmCommand.binary,
    args: cbmCommand.args,
    source: cbmCommand.source,
    ...(cbmCommand.configPath ? { configPath: cbmCommand.configPath } : {}),
    project: projectId,
  };

  const endpoints = resolveContextSemanticEndpoints(process.env);
  const redisConnectTimeoutMs = Number(process.env.CONTEXT_SEMANTIC_REDIS_CONNECT_TIMEOUT_MS ?? 5_000);
  const redisCommandTimeoutMs = Number(process.env.CONTEXT_SEMANTIC_REDIS_COMMAND_TIMEOUT_MS ?? 5_000);
  const needsSharedRedis = !deps?.cache || !deps?.semanticCache;
  const redisPool = needsSharedRedis
    ? new ContextRedisPool({
        urls: endpoints.redisUrls,
        labels: endpoints.redisUrls.map((_, index) => `redis-${index + 1}`),
        connectTimeoutMs: redisConnectTimeoutMs,
        commandTimeoutMs: redisCommandTimeoutMs,
        failureCooldownMs: Number(process.env.CONTEXT_SEMANTIC_CACHE_FAILURE_COOLDOWN_MS ?? 30_000),
      })
    : undefined;

  const memoryConnectionString = resolveProjectMemoryConnectionString();
  const memory = deps?.memory ?? new ProjectMemory({
    ...(memoryConnectionString ? { connectionString: memoryConnectionString } : {}),
    projectId,
    poolMax: Number(process.env.CONTEXT_ENGINE_PROJECT_MEMORY_POOL_MAX ?? 4),
    migrationRequired: boolEnv("CONTEXT_ENGINE_PROJECT_MEMORY_MIGRATION_REQUIRED", true),
    allowEmptyInstall: boolEnv("CONTEXT_ENGINE_PROJECT_MEMORY_ALLOW_EMPTY_INSTALL", false),
  });
  const summaryManager = deps?.summaryManager ?? new SummaryManager(cbm, "", "");
  const context7 = deps?.context7 ?? new Context7Adapter();
  const serena = deps?.serena ?? new SerenaAdapter(cwd);
  const cache = deps?.cache ?? new TieredContextCache(
    new L1SessionCache(Number(process.env.CONTEXT_ENGINE_L1_TTL_MS ?? 600_000)),
    new RedisExactCache({
      members: redisPool!.members,
      namespace: process.env.CONTEXT_ENGINE_EXACT_CACHE_NAMESPACE?.trim() || "agent:harness:context:exact:v1",
      failureMode: process.env.CONTEXT_SEMANTIC_CACHE_FAILURE_MODE === "closed" ? "closed" : "open",
      memberOperationTimeoutMs: Number(
        process.env.CONTEXT_EXACT_REDIS_MEMBER_TIMEOUT_MS
        ?? process.env.CONTEXT_SEMANTIC_POOL_MEMBER_HEALTH_TIMEOUT_MS
        ?? 1_500,
      ),
      memberFailureCooldownMs: Number(
        process.env.CONTEXT_EXACT_REDIS_FAILURE_COOLDOWN_MS
        ?? process.env.CONTEXT_SEMANTIC_CACHE_FAILURE_COOLDOWN_MS
        ?? 30_000,
      ),
    }),
  );
  const semanticResolved = deps?.semanticCache
    ? {
        cache: deps.semanticCache,
        ...endpoints,
      }
    : createContextSemanticCache(cwd, process.env, { redisMembers: redisPool!.members });
  const semanticCache = semanticResolved.cache;
  const staticArtifactsEnabled = process.env.CONTEXT_ENGINE_STATIC_ARTIFACTS_ENABLED !== "false";
  const packBuilder = deps?.packBuilder ?? new ContextPackBuilder(cbm, memory, summaryManager, context7, {
    cache,
    cwd,
    semanticCache,
    semanticScopeDefaults: {
      projectId: semanticCache.config.projectId,
      branch: semanticCache.config.branch,
      schemaVersion: semanticCache.config.schemaVersion,
    },
    ...(staticArtifactsEnabled ? {} : { staticArtifacts: false }),
    staticArtifactTtlMs: Number(process.env.CONTEXT_ENGINE_STATIC_ARTIFACT_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
    staticArtifactLimit: Number(process.env.CONTEXT_ENGINE_STATIC_ARTIFACT_LIMIT ?? 8),
  });
  const referenceStore = deps?.referenceStore ?? new ContextReferenceStore(
    cache,
    Number(process.env.CONTEXT_ENGINE_REFERENCE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
    cwd,
  );
  const stats = deps?.stats ?? new StatsCollector();
  stats.setCacheStatsProvider(() => cache.getStats());
  stats.setSemanticCacheStatsProvider(() => semanticCache.getStats());

  const contextProvider: ContextProvider = async ({
    task,
    budgetTokens = 18_000,
    mode = "compact",
    projectId: requestProjectId,
    branch,
    role,
    stage,
    schemaVersion,
  }) => {
    const semanticScope = Object.fromEntries(
      Object.entries({ projectId: requestProjectId, branch, role, stage, schemaVersion }).filter(([, value]) => Boolean(value)),
    ) as NonNullable<ContextPackBuildContext["semanticScope"]>;
    const result = await buildTaskContext(
      packBuilder,
      referenceStore,
      stats,
      task,
      budgetTokens,
      mode,
      Object.keys(semanticScope).length > 0 ? { semanticScope } : {},
    );
    return {
      status: "ok",
      packId: result.packId,
      cacheStatus: result.cacheStatus,
      payload: result.payload,
      metrics: {
        budgetTokens: result.budget,
        rawTokens: result.rawTokens,
        deliveredTokens: result.deliveredTokens,
        tokensSaved: result.tokensSaved,
        savingsPercent: result.savingsPercent,
        cacheHit: result.cacheHit,
        cacheTier: result.cacheTier ?? null,
        componentCache: structuredClone(result.componentCache),
        semanticCache: result.semanticCache ? structuredClone(result.semanticCache) as unknown as Record<string, unknown> : null,
      },
    };
  };

  const close = async (): Promise<void> => {
    await semanticCache.close().catch(() => undefined);
    await memory.close().catch(() => undefined);
    await cache.close().catch(() => undefined);
    await redisPool?.close().catch(() => undefined);
  };

  return {
    cbm,
    memory,
    summaryManager,
    context7,
    serena,
    packBuilder,
    cache,
    referenceStore,
    stats,
    semanticCache,
    contextProvider,
    cbmRuntime,
    semanticRuntime: {
      networkMode: semanticResolved.networkMode,
      redisUrl: semanticResolved.redisUrl,
      redisUrls: semanticResolved.redisUrls,
      embeddingBaseUrl: semanticResolved.embeddingBaseUrl,
      embeddingBaseUrls: semanticResolved.embeddingBaseUrls,
    },
    close,
  };
}
