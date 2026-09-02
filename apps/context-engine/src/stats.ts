import type { CacheTier, TieredCacheStats } from "@agent-harness/context-cache";
import type { SemanticCacheStats } from "@agent-harness/context-semantic-cache";

export interface ToolStats {
  calls: number;
  errors: number;
  total_latency_ms: number;
}

export interface DeliveryStats {
  compact_calls: number;
  full_calls: number;
  pack_cache_hits: number;
  pack_cache_misses: number;
  pack_cache_l1_hits: number;
  pack_cache_l2_hits: number;
  pack_cache_hit_rate: number;
  full_tokens: number;
  delivered_tokens: number;
  tokens_saved: number;
  savings_percent: number;
  requested_budget_tokens: number;
  budget_headroom_tokens: number;
  budget_overflow_tokens: number;
  budget_utilization_percent: number;
}

export interface ContextEngineStats {
  uptime_seconds: number;
  total_packs_built: number;
  total_tokens_used: number;
  tools: Record<string, ToolStats>;
  delivery: DeliveryStats;
  cache?: TieredCacheStats;
  semantic_cache?: SemanticCacheStats;
  started_at: string;
}

export class StatsCollector {
  private calls = new Map<string, number>();
  private errors = new Map<string, number>();
  private latencies = new Map<string, number>();
  private packsBuilt = 0;
  private tokensUsed = 0;
  private startedAt = Date.now();
  private compactCalls = 0;
  private fullCalls = 0;
  private packCacheHits = 0;
  private packCacheMisses = 0;
  private packCacheL1Hits = 0;
  private packCacheL2Hits = 0;
  private fullTokens = 0;
  private deliveredTokens = 0;
  private requestedBudgetTokens = 0;
  private cacheStatsProvider?: () => TieredCacheStats;
  private semanticCacheStatsProvider?: () => SemanticCacheStats;

  recordCall(tool: string, latencyMs: number): void {
    this.calls.set(tool, (this.calls.get(tool) ?? 0) + 1);
    this.latencies.set(tool, (this.latencies.get(tool) ?? 0) + latencyMs);
  }

  recordError(tool: string): void {
    this.errors.set(tool, (this.errors.get(tool) ?? 0) + 1);
  }

  recordPack(
    fullTokens: number,
    deliveredTokens = fullTokens,
    options: { mode?: "compact" | "full"; cacheHit?: boolean; cacheTier?: CacheTier; budgetTokens?: number } = {},
  ): void {
    this.packsBuilt++;
    this.tokensUsed += deliveredTokens;
    this.fullTokens += fullTokens;
    this.deliveredTokens += deliveredTokens;
    if (Number.isFinite(options.budgetTokens) && Number(options.budgetTokens) > 0) {
      this.requestedBudgetTokens += Number(options.budgetTokens);
    }
    if (options.mode === "compact") this.compactCalls++;
    else this.fullCalls++;

    if (options.cacheHit === true) {
      this.packCacheHits++;
      if (options.cacheTier === "l1") this.packCacheL1Hits++;
      if (options.cacheTier === "l2") this.packCacheL2Hits++;
    } else if (options.cacheHit === false) {
      this.packCacheMisses++;
    }
  }

  setCacheStatsProvider(provider: () => TieredCacheStats): void {
    this.cacheStatsProvider = provider;
  }

  setSemanticCacheStatsProvider(provider: () => SemanticCacheStats): void {
    this.semanticCacheStatsProvider = provider;
  }

  getStats(): ContextEngineStats {
    const tools: Record<string, ToolStats> = {};
    const allTools = new Set([...this.calls.keys(), ...this.errors.keys()]);
    for (const tool of allTools) {
      tools[tool] = {
        calls: this.calls.get(tool) ?? 0,
        errors: this.errors.get(tool) ?? 0,
        total_latency_ms: this.latencies.get(tool) ?? 0,
      };
    }
    const tokensSaved = Math.max(0, this.fullTokens - this.deliveredTokens);
    const packLookups = this.packCacheHits + this.packCacheMisses;
    const budgetHeadroomTokens = Math.max(0, this.requestedBudgetTokens - this.deliveredTokens);
    const budgetOverflowTokens = Math.max(0, this.deliveredTokens - this.requestedBudgetTokens);
    const result: ContextEngineStats = {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      total_packs_built: this.packsBuilt,
      total_tokens_used: this.tokensUsed,
      tools,
      delivery: {
        compact_calls: this.compactCalls,
        full_calls: this.fullCalls,
        pack_cache_hits: this.packCacheHits,
        pack_cache_misses: this.packCacheMisses,
        pack_cache_l1_hits: this.packCacheL1Hits,
        pack_cache_l2_hits: this.packCacheL2Hits,
        pack_cache_hit_rate: packLookups === 0 ? 0 : this.packCacheHits / packLookups,
        full_tokens: this.fullTokens,
        delivered_tokens: this.deliveredTokens,
        tokens_saved: tokensSaved,
        savings_percent: this.fullTokens === 0 ? 0 : (tokensSaved / this.fullTokens) * 100,
        requested_budget_tokens: this.requestedBudgetTokens,
        budget_headroom_tokens: budgetHeadroomTokens,
        budget_overflow_tokens: budgetOverflowTokens,
        budget_utilization_percent: this.requestedBudgetTokens === 0 ? 0 : (this.deliveredTokens / this.requestedBudgetTokens) * 100,
      },
      started_at: new Date(this.startedAt).toISOString(),
    };
    if (this.cacheStatsProvider) result.cache = this.cacheStatsProvider();
    if (this.semanticCacheStatsProvider) result.semantic_cache = this.semanticCacheStatsProvider();
    return result;
  }
}
