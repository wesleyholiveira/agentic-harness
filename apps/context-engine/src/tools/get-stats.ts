import type { Visibility } from "../visibility.js";
import type { SemanticCacheStats, SemanticContextCache } from "@agent-harness/context-semantic-cache";
import type { StatsCollector } from "../stats.js";

export function normalizeSemanticIncidentStats(stats: SemanticCacheStats): SemanticCacheStats {
  const dependency = stats.last_unavailable_dependency ?? stats.incident?.dependency ?? null;
  const message = stats.last_error_message ?? stats.incident?.message ?? null;
  let lastErrorCode = stats.last_error_code ?? stats.incident?.error_code ?? null;
  let lastCauseCode = stats.last_cause_code ?? stats.incident?.cause_code ?? null;

  if ((!lastErrorCode || !lastCauseCode) && typeof message === "string") {
    const match = /context_semantic_dependency_unavailable:([^:]+):([^:]+)(?::|$)/.exec(message);
    if (match) {
      lastErrorCode ??= "context_semantic_dependency_unavailable";
      lastCauseCode ??= match[2] ?? null;
    }
  }

  if (!lastErrorCode && dependency) lastErrorCode = "context_semantic_dependency_unavailable";
  if (!lastCauseCode && dependency === "embedding") lastCauseCode = "semantic_embedding_transport_unavailable";
  if (!lastCauseCode && dependency === "redis") lastCauseCode = "semantic_redis_unavailable";

  const unavailableUntil = stats.unavailable_until ?? stats.incident?.unavailable_until ?? null;
  return {
    ...stats,
    stats_contract_version: "semantic-cache-stats/v2",
    incident: {
      dependency,
      error_code: lastErrorCode,
      cause_code: lastCauseCode,
      message,
      unavailable_until: unavailableUntil,
    },
    last_unavailable_dependency: dependency,
    last_error_code: lastErrorCode,
    last_cause_code: lastCauseCode,
    last_error_message: message,
    unavailable_until: unavailableUntil,
  };
}

export function registerGetStats(
  visibility: Visibility,
  stats: StatsCollector,
  semanticCache?: Pick<SemanticContextCache, "getStats">,
): void {
  visibility.registerVisibleTool(
    "context_stats",
    {
      description:
        "Get Context Engine statistics: tool calls/errors/latency, raw-pack L1/L2 hit rate, semantic candidate-cache metrics, physical cache tiers, delivery mode, and token savings.",
      inputSchema: {},
    },
    async () => {
      const statsData = stats.getStats();
      // context_stats must project incident history from the live semantic-cache
      // instance, not rely solely on a previously registered stats provider.
      // Normalize legacy/incomplete incident history so request, health and stats
      // expose the same stable error_code/cause_code contract.
      if (semanticCache) statsData.semantic_cache = normalizeSemanticIncidentStats(semanticCache.getStats());
      else if (statsData.semantic_cache) statsData.semantic_cache = normalizeSemanticIncidentStats(statsData.semantic_cache);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(statsData, null, 2) }],
        _meta: statsData.semantic_cache
          ? {
              semantic_cache_stats_contract_version: statsData.semantic_cache.stats_contract_version,
              semantic_cache_incident: statsData.semantic_cache.incident,
            }
          : {},
      };
    },
  );
}
