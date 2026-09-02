import {
  estimateTokens,
  toCompactContextPack,
  type ContextPackBuildContext,
  type ContextPackBuilder,
  type ContextReferenceStore,
  type SemanticCacheMetadata,
} from "@agent-harness/context-pack";
import type { StatsCollector } from "./stats.js";

export type ContextDeliveryMode = "compact" | "full";

export interface TaskContextResult {
  payload: unknown;
  mode: ContextDeliveryMode;
  packId: string | null;
  cacheStatus: string;
  cacheHit: boolean;
  cacheTier?: "l1" | "l2";
  componentCache: {
    hits: number;
    misses: number;
    hit_sources: string[];
    miss_sources: string[];
  };
  semanticCache?: SemanticCacheMetadata;
  sources: string[];
  warnings: string[];
  budget: number;
  rawTokens: number;
  deliveredTokens: number;
  tokensSaved: number;
  savingsPercent: number;
  staticArtifactCount: number;
}

export function cacheStatus(cacheHit: boolean, tier: "l1" | "l2" | undefined): string {
  if (!cacheHit) return "cache-miss";
  return tier ? `cache-hit-${tier}` : "cache-hit";
}

export function cacheSummary(result: TaskContextResult): string {
  const raw = result.cacheHit
    ? `PACK HIT ${result.cacheTier?.toUpperCase() ?? "CACHE"}`
    : "PACK MISS";
  const component = `${result.componentCache.hits} component hits / ${result.componentCache.misses} misses`;
  const semantic = result.semanticCache ? `semantic=${result.semanticCache.status}` : "semantic=off";
  return `${raw} · ${component} · ${semantic} · ${result.mode} · ${result.rawTokens}→${result.deliveredTokens} tokens`;
}

export async function buildTaskContext(
  builder: ContextPackBuilder,
  references: ContextReferenceStore | undefined,
  stats: StatsCollector | undefined,
  task: string,
  budget = 18_000,
  requestedMode: ContextDeliveryMode = "compact",
  context: ContextPackBuildContext = {},
): Promise<TaskContextResult> {
  const { pack, rawPack } = await builder.buildWithRaw(task, budget, context);
  const useCompact = requestedMode === "compact" && references !== undefined;
  const mode: ContextDeliveryMode = useCompact ? "compact" : "full";
  const payload = useCompact && references ? await toCompactContextPack(rawPack, references) : pack;
  const rawTokens = estimateTokens(rawPack);
  const deliveredTokens = estimateTokens(payload);
  const tokensSaved = Math.max(0, rawTokens - deliveredTokens);
  const savingsPercent = rawTokens === 0 ? 0 : (tokensSaved / rawTokens) * 100;
  const componentCache = rawPack.metadata.component_cache ?? {
    hits: 0,
    misses: 0,
    hit_sources: [],
    miss_sources: [],
  };
  const status = cacheStatus(rawPack.metadata.cache_hit, rawPack.metadata.cache_tier);

  stats?.recordPack(rawTokens, deliveredTokens, {
    mode,
    cacheHit: rawPack.metadata.cache_hit,
    ...(rawPack.metadata.cache_tier ? { cacheTier: rawPack.metadata.cache_tier } : {}),
    budgetTokens: rawPack.metadata.budget,
  });

  const packId =
    payload && typeof payload === "object" && "pack_id" in payload && typeof payload.pack_id === "string"
      ? payload.pack_id
      : null;

  return {
    payload,
    mode,
    packId,
    cacheStatus: status,
    cacheHit: rawPack.metadata.cache_hit,
    ...(rawPack.metadata.cache_tier ? { cacheTier: rawPack.metadata.cache_tier } : {}),
    ...(rawPack.metadata.semantic_cache ? { semanticCache: structuredClone(rawPack.metadata.semantic_cache) } : {}),
    componentCache,
    sources: rawPack.metadata.sources_queried,
    warnings: rawPack.metadata.warnings,
    budget: rawPack.metadata.budget,
    rawTokens,
    deliveredTokens,
    tokensSaved,
    savingsPercent,
    staticArtifactCount: rawPack.static_artifacts.length,
  };
}
