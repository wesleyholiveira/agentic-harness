import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ContextRedisMember } from "@agent-harness/context-redis";
import {
  DeterministicSemanticEmbeddingProvider,
  RedisSemanticCandidateStore,
  RedundantSemanticCandidateStore,
  RedundantSemanticEmbeddingProvider,
  SemanticContextCache,
  TeiEmbeddingProvider,
  type SemanticCacheFailureMode,
  type SemanticCacheMode,
  type SemanticCandidateStore,
  type SemanticEmbeddingProvider,
} from "@agent-harness/context-semantic-cache";

export type ContextSemanticNetworkMode = "auto" | "host" | "container";

export interface ContextSemanticResolvedConfig {
  cache: SemanticContextCache;
  networkMode: "host" | "container";
  /** Backward-compatible alias for the first configured Redis endpoint. */
  redisUrl: string;
  redisUrls: string[];
  /** Backward-compatible alias for the first configured embedding endpoint. */
  embeddingBaseUrl: string;
  embeddingBaseUrls: string[];
}

interface EndpointMapping {
  composeHost: string;
  host: string;
  hostPort: number;
  containerPort: number;
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, code: string): T {
  const normalized = value?.trim().toLowerCase() || fallback;
  if (!allowed.includes(normalized as T)) throw new Error(`${code}:${normalized}`);
  return normalized as T;
}

function finiteNumber(value: string | undefined, fallback: number, min: number, max: number, code: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${code}:${value ?? ""}`);
  return parsed;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, code: string): number {
  const parsed = finiteNumber(value, fallback, min, max, code);
  if (!Number.isInteger(parsed)) throw new Error(`${code}:${value ?? ""}`);
  return parsed;
}

function containerRuntime(environment: NodeJS.ProcessEnv, mode: ContextSemanticNetworkMode): boolean {
  if (mode === "container") return true;
  if (mode === "host") return false;
  return Boolean(environment.KUBERNETES_SERVICE_HOST) || existsSync("/.dockerenv");
}

function endpointList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueEndpoints(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\/+$/, "")))];
}

function rewriteComposeUrlForHost(value: string, mappings: EndpointMapping[]): string {
  const parsed = new URL(value);
  const mapping = mappings.find((candidate) => parsed.hostname === candidate.composeHost);
  if (!mapping) return value.replace(/\/+$/, "");
  parsed.hostname = mapping.host;
  parsed.port = String(mapping.hostPort);
  return parsed.toString().replace(/\/+$/, "");
}

function rewriteHostUrlForContainer(value: string, mappings: EndpointMapping[]): string {
  const parsed = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", ...mappings.map((mapping) => mapping.host)]);
  if (!loopbackHosts.has(parsed.hostname)) return value.replace(/\/+$/, "");
  const explicitPort = parsed.port ? Number(parsed.port) : undefined;
  const mapping = explicitPort === undefined
    ? mappings[0]
    : mappings.find((candidate) => candidate.hostPort === explicitPort) ?? mappings[0];
  if (!mapping) return value.replace(/\/+$/, "");
  parsed.hostname = mapping.composeHost;
  parsed.port = String(mapping.containerPort);
  return parsed.toString().replace(/\/+$/, "");
}

function resolveEndpointPool(
  plural: string | undefined,
  singular: string | undefined,
  defaults: string[],
  mappings: EndpointMapping[],
  inContainer: boolean,
): string[] {
  const explicitPool = endpointList(plural);
  const configured = explicitPool.length > 0
    ? explicitPool
    : singular?.trim()
      ? [singular.trim()]
      : defaults;
  return uniqueEndpoints(configured.map((value) => inContainer
    ? rewriteHostUrlForContainer(value, mappings)
    : rewriteComposeUrlForHost(value, mappings)));
}

export function resolveContextSemanticEndpoints(
  environment: NodeJS.ProcessEnv = process.env,
): {
  networkMode: "host" | "container";
  redisUrl: string;
  redisUrls: string[];
  embeddingBaseUrl: string;
  embeddingBaseUrls: string[];
} {
  const requestedMode = enumValue(
    environment.CONTEXT_SEMANTIC_NETWORK_MODE,
    ["auto", "host", "container"] as const,
    "auto",
    "context_semantic_network_mode_invalid",
  );
  const inContainer = containerRuntime(environment, requestedMode);
  const networkMode = inContainer ? "container" : "host";

  const redisHost = environment.CONTEXT_SEMANTIC_REDIS_HOST?.trim() || "127.0.0.1";
  const redisPrimary: EndpointMapping = {
    composeHost: environment.CONTEXT_SEMANTIC_REDIS_COMPOSE_HOST?.trim() || "context-semantic-redis",
    host: redisHost,
    hostPort: integer(
      environment.CONTEXT_SEMANTIC_REDIS_HOST_PORT,
      6380,
      1,
      65535,
      "context_semantic_redis_host_port_invalid",
    ),
    containerPort: 6379,
  };
  const redisSecondary: EndpointMapping = {
    composeHost: environment.CONTEXT_SEMANTIC_REDIS_SECONDARY_COMPOSE_HOST?.trim() || "context-semantic-redis-secondary",
    host: environment.CONTEXT_SEMANTIC_REDIS_SECONDARY_HOST?.trim() || redisHost,
    hostPort: integer(
      environment.CONTEXT_SEMANTIC_REDIS_SECONDARY_HOST_PORT,
      6381,
      1,
      65535,
      "context_semantic_redis_secondary_host_port_invalid",
    ),
    containerPort: 6379,
  };
  const redisMappings = [redisPrimary, redisSecondary];
  const redisUrls = resolveEndpointPool(
    environment.CONTEXT_SEMANTIC_REDIS_URLS,
    environment.CONTEXT_SEMANTIC_REDIS_URL,
    redisMappings.map((mapping) => `redis://${mapping.composeHost}:${mapping.containerPort}`),
    redisMappings,
    inContainer,
  );

  const embeddingHost = environment.CONTEXT_SEMANTIC_EMBEDDING_HOST?.trim() || "127.0.0.1";
  const embeddingPrimary: EndpointMapping = {
    composeHost: environment.CONTEXT_SEMANTIC_EMBEDDING_COMPOSE_HOST?.trim() || "context-embeddings",
    host: embeddingHost,
    hostPort: integer(
      environment.CONTEXT_SEMANTIC_EMBEDDING_HOST_PORT,
      8791,
      1,
      65535,
      "context_semantic_embedding_host_port_invalid",
    ),
    containerPort: 80,
  };
  const embeddingSecondary: EndpointMapping = {
    composeHost: environment.CONTEXT_SEMANTIC_EMBEDDING_SECONDARY_COMPOSE_HOST?.trim() || "context-embeddings-secondary",
    host: environment.CONTEXT_SEMANTIC_EMBEDDING_SECONDARY_HOST?.trim() || embeddingHost,
    hostPort: integer(
      environment.CONTEXT_SEMANTIC_EMBEDDING_SECONDARY_HOST_PORT,
      8792,
      1,
      65535,
      "context_semantic_embedding_secondary_host_port_invalid",
    ),
    containerPort: 80,
  };
  const embeddingMappings = [embeddingPrimary, embeddingSecondary];
  const embeddingBaseUrls = resolveEndpointPool(
    environment.CONTEXT_SEMANTIC_EMBEDDING_BASE_URLS,
    environment.CONTEXT_SEMANTIC_EMBEDDING_BASE_URL,
    embeddingMappings.map((mapping) => `http://${mapping.composeHost}:${mapping.containerPort}`),
    embeddingMappings,
    inContainer,
  );

  const redisUrl = redisUrls[0];
  const embeddingBaseUrl = embeddingBaseUrls[0];
  if (!redisUrl) throw new Error("context_semantic_redis_endpoints_required");
  if (!embeddingBaseUrl) throw new Error("context_semantic_embedding_endpoints_required");
  return { networkMode, redisUrl, redisUrls, embeddingBaseUrl, embeddingBaseUrls };
}

function resolveBranch(cwd: string, environment: NodeJS.ProcessEnv): string {
  const explicit = environment.CONTEXT_SEMANTIC_CACHE_BRANCH?.trim();
  if (explicit) return explicit;
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim() || "unknown-branch";
  } catch {
    return "unknown-branch";
  }
}

export function createContextSemanticCache(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: { redisMembers?: ContextRedisMember[] } = {},
): ContextSemanticResolvedConfig {
  const mode = enumValue<SemanticCacheMode>(
    environment.CONTEXT_SEMANTIC_CACHE_MODE,
    ["off", "observe", "enforce"] as const,
    "observe",
    "context_semantic_cache_mode_invalid",
  );
  const failureMode = enumValue<SemanticCacheFailureMode>(
    environment.CONTEXT_SEMANTIC_CACHE_FAILURE_MODE,
    ["open", "closed"] as const,
    "open",
    "context_semantic_cache_failure_mode_invalid",
  );
  if (mode === "observe" && failureMode === "closed") {
    throw new Error("context_semantic_observe_requires_failure_open");
  }
  const endpoints = resolveContextSemanticEndpoints(environment);
  const dimensions = integer(
    environment.CONTEXT_SEMANTIC_EMBEDDING_DIMENSIONS,
    384,
    1,
    8192,
    "context_semantic_embedding_dimensions_invalid",
  );
  const modelId = environment.CONTEXT_SEMANTIC_EMBEDDING_MODEL?.trim()
    || "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
  const revision = environment.CONTEXT_SEMANTIC_EMBEDDING_MODEL_REVISION?.trim()
    || "e8f8c211226b894fcb81acc59f3b34ba3efd5f42";
  const provider = environment.CONTEXT_SEMANTIC_EMBEDDING_PROVIDER?.trim().toLowerCase() || "tei";
  const testMode = environment.AGENT_HARNESS_CONTEXT_SEMANTIC_TEST_MODE === "1";
  if (provider !== "tei" && !(provider === "deterministic" && testMode)) {
    throw new Error(`context_semantic_embedding_provider_invalid:${provider}`);
  }

  const closedMinEndpoints = integer(
    environment.CONTEXT_SEMANTIC_CLOSED_MIN_ENDPOINTS,
    2,
    1,
    16,
    "context_semantic_closed_min_endpoints_invalid",
  );
  if (mode === "enforce" && failureMode === "closed") {
    if (endpoints.redisUrls.length < closedMinEndpoints) {
      throw new Error(`context_semantic_closed_redundancy_required:redis:${endpoints.redisUrls.length}:${closedMinEndpoints}`);
    }
    if (provider === "tei" && endpoints.embeddingBaseUrls.length < closedMinEndpoints) {
      throw new Error(`context_semantic_closed_redundancy_required:embedding:${endpoints.embeddingBaseUrls.length}:${closedMinEndpoints}`);
    }
  }

  const embeddingTimeoutMs = integer(
    environment.CONTEXT_SEMANTIC_EMBEDDING_TIMEOUT_MS,
    10_000,
    250,
    120_000,
    "context_semantic_embedding_timeout_invalid",
  );
  const poolHealthTimeoutMs = integer(
    environment.CONTEXT_SEMANTIC_POOL_MEMBER_HEALTH_TIMEOUT_MS,
    1_500,
    100,
    30_000,
    "context_semantic_pool_member_health_timeout_invalid",
  );

  let embeddings: SemanticEmbeddingProvider;
  if (provider === "deterministic") {
    embeddings = new DeterministicSemanticEmbeddingProvider(dimensions);
  } else {
    const providers = endpoints.embeddingBaseUrls.map((baseUrl) => new TeiEmbeddingProvider({
      baseUrl,
      modelId,
      revision,
      dimensions,
      timeoutMs: embeddingTimeoutMs,
    }));
    embeddings = providers.length === 1
      ? providers[0]!
      : new RedundantSemanticEmbeddingProvider(
          providers,
          endpoints.embeddingBaseUrls.map((_, index) => `embedding-${index + 1}`),
          { healthTimeoutMs: poolHealthTimeoutMs, minHealthy: 1 },
        );
  }

  const embeddingIdentity = `${embeddings.modelId}@${embeddings.revision}`;
  const redisConnectTimeoutMs = integer(
    environment.CONTEXT_SEMANTIC_REDIS_CONNECT_TIMEOUT_MS,
    5_000,
    100,
    120_000,
    "context_semantic_redis_connect_timeout_invalid",
  );
  const redisCommandTimeoutMs = integer(
    environment.CONTEXT_SEMANTIC_REDIS_COMMAND_TIMEOUT_MS,
    5_000,
    100,
    120_000,
    "context_semantic_redis_command_timeout_invalid",
  );
  const maxPayloadBytes = integer(
    environment.CONTEXT_SEMANTIC_CACHE_MAX_PAYLOAD_BYTES,
    2 * 1024 * 1024,
    1024,
    32 * 1024 * 1024,
    "context_semantic_cache_max_payload_bytes_invalid",
  );
  const redisMembers = options.redisMembers;
  if (redisMembers && redisMembers.length !== endpoints.redisUrls.length) {
    throw new Error(`context_semantic_shared_redis_topology_mismatch:${redisMembers.length}:${endpoints.redisUrls.length}`);
  }
  const stores = endpoints.redisUrls.map((url, index) => new RedisSemanticCandidateStore({
    url,
    ...(redisMembers?.[index] ? { client: redisMembers[index]!.client } : {}),
    embeddingModel: embeddingIdentity,
    dimensions,
    indexPrefix: environment.CONTEXT_SEMANTIC_REDIS_INDEX_PREFIX?.trim() || "agent:harness:context:semantic",
    connectTimeoutMs: redisConnectTimeoutMs,
    commandTimeoutMs: redisCommandTimeoutMs,
    maxPayloadBytes,
  }));
  const store: SemanticCandidateStore = stores.length === 1
    ? stores[0]!
    : new RedundantSemanticCandidateStore(
        stores,
        (redisMembers ?? endpoints.redisUrls.map((url, index) => ({ label: `redis-${index + 1}`, url } as ContextRedisMember))).map((member, index) => member.label || `redis-${index + 1}`),
        { healthTimeoutMs: poolHealthTimeoutMs, minHealthy: 1 },
      );

  const projectId = environment.CONTEXT_SEMANTIC_CACHE_PROJECT_ID?.trim()
    || environment.CODEBASE_MEMORY_PROJECT?.trim()
    || basename(resolve(cwd));
  const cache = new SemanticContextCache({
    mode,
    failureMode,
    minSimilarity: finiteNumber(
      environment.CONTEXT_SEMANTIC_CACHE_MIN_SIMILARITY,
      0.88,
      -1,
      1,
      "context_semantic_cache_min_similarity_invalid",
    ),
    topK: integer(environment.CONTEXT_SEMANTIC_CACHE_TOP_K, 5, 1, 50, "context_semantic_cache_top_k_invalid"),
    ttlMs: integer(
      environment.CONTEXT_SEMANTIC_CACHE_TTL_MS,
      7 * 24 * 60 * 60 * 1000,
      60_000,
      90 * 24 * 60 * 60 * 1000,
      "context_semantic_cache_ttl_invalid",
    ),
    failureCooldownMs: integer(
      environment.CONTEXT_SEMANTIC_CACHE_FAILURE_COOLDOWN_MS,
      30_000,
      1_000,
      10 * 60 * 1000,
      "context_semantic_cache_failure_cooldown_invalid",
    ),
    projectId,
    branch: resolveBranch(cwd, environment),
    schemaVersion: environment.CONTEXT_SEMANTIC_CACHE_SCHEMA_VERSION?.trim() || "context-semantic-candidate/v1",
    cwd,
  }, store, embeddings);
  return { cache, ...endpoints };
}
