import { createHash } from "node:crypto";
import { SemanticDependencyUnavailableError, semanticDependencyError, type SemanticDependency } from "./errors";
import type {
  SemanticCacheConfig,
  SemanticCacheHealth,
  SemanticCacheLookupInput,
  SemanticCacheLookupResult,
  SemanticCacheStats,
  SemanticCacheStoreInput,
  SemanticCacheWriteResult,
  SemanticCandidateStore,
  SemanticEmbeddingProvider,
  SemanticReuseOutcome,
  SemanticTaskDescriptor,
} from "./types";

function stableTaskText(value: string): string {
  return value
    .replace(/\brun-[0-9a-f-]{16,}\b/gi, "run-<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\bsha256:[0-9a-f]{32,}\b/gi, "sha256:<digest>")
    .replace(/\b[0-9a-f]{24,}\b/gi, "<digest>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b\d{13}\b/g, "<timestamp-ms>");
}

export function semanticTaskText(task: SemanticTaskDescriptor): string {
  return [
    `intent:${task.intent}`,
    `domains:${task.domains.join(",") || "unknown"}`,
    `language:${task.language}`,
    `files:${task.files.join(",") || "none"}`,
    `symbols:${task.symbols.join(",") || "none"}`,
    `query:${stableTaskText(task.canonicalQuery)}`,
    `task:${stableTaskText(task.text)}`,
  ].join("\n");
}

function candidateId(input: SemanticCacheStoreInput): string {
  // Candidate identity must follow the same stable semantic task identity used
  // for embeddings. Exact task fingerprints/source-pack keys can contain
  // transient run IDs, which previously created many vector-identical keys.
  // Those duplicates could fill top-k with stale revisions after a cutover and
  // hide the candidate that had just been written by the current request.
  return createHash("sha256")
    .update(JSON.stringify({
      version: 2,
      scope: input.scope,
      semanticTask: semanticTaskText(input.task),
    }))
    .digest("hex");
}

export class SemanticContextCache {
  private readonly counters = {
    lookups: 0,
    candidateHits: 0,
    misses: 0,
    storeAttempts: 0,
    stores: 0,
    errors: 0,
    cooldownSkips: 0,
    embeddingCalls: 0,
    acceptedCandidates: 0,
    rejectedCandidates: 0,
    componentsConsidered: 0,
    componentsReusable: 0,
    componentsReused: 0,
    componentsRefreshed: 0,
    componentsStale: 0,
    retrievalCallsAvoided: 0,
    tokensAvoidedEstimate: 0,
    totalLookupLatencyMs: 0,
    totalEmbeddingLatencyMs: 0,
    totalWriteLatencyMs: 0,
  };

  private unavailableUntil = 0;
  private lastUnavailableError: string | undefined;
  private lastUnavailableErrorCode: "context_semantic_dependency_unavailable" | undefined;
  private lastUnavailableDependency: SemanticDependency | undefined;
  private lastUnavailableCauseCode: string | undefined;

  constructor(
    readonly config: SemanticCacheConfig,
    readonly store: SemanticCandidateStore,
    readonly embeddings: SemanticEmbeddingProvider,
  ) {}

  private inFailureCooldown(): boolean {
    return Date.now() < this.unavailableUntil;
  }

  private markUnavailable(error: unknown, dependency: SemanticDependency): SemanticDependencyUnavailableError {
    const wrapped = semanticDependencyError(
      dependency,
      error,
      dependency === "embedding" ? "semantic_embedding_unavailable" : "semantic_redis_unavailable",
    );
    const newIncident = this.lastUnavailableError === undefined
      || this.lastUnavailableDependency !== wrapped.dependency
      || Date.now() >= this.unavailableUntil;
    if (newIncident) this.counters.errors++;
    this.lastUnavailableError = wrapped.message;
    this.lastUnavailableErrorCode = wrapped.code;
    this.lastUnavailableDependency = wrapped.dependency;
    this.lastUnavailableCauseCode = wrapped.causeCode;
    this.unavailableUntil = Date.now() + this.config.failureCooldownMs;
    return wrapped;
  }

  private clearUnavailable(): void {
    // Clear only the active cooldown boundary. The last_* fields are historical
    // incident telemetry and must remain observable through context_stats after
    // recovery; otherwise an operator loses the reason for the most recent
    // semantic dependency outage as soon as health turns green.
    this.unavailableUntil = 0;
  }

  async lookup(input: SemanticCacheLookupInput): Promise<SemanticCacheLookupResult> {
    if (this.config.mode === "off") {
      return {
        mode: "off",
        status: "disabled",
        candidateHit: false,
        candidates: [],
        candidatesConsidered: 0,
        lookupMs: 0,
        embeddingMs: 0,
        warnings: [],
      };
    }
    const startedAt = Date.now();
    this.counters.lookups++;
    if (this.inFailureCooldown()) {
      this.counters.cooldownSkips++;
      const cooldownError = new SemanticDependencyUnavailableError(
        this.lastUnavailableDependency ?? "unknown",
        this.lastUnavailableCauseCode ?? "semantic_cache_cooldown",
        `semantic cache dependency remains in cooldown until ${new Date(this.unavailableUntil).toISOString()}`,
      );
      if (this.config.failureMode === "closed") throw cooldownError;
      return {
        mode: this.config.mode,
        status: "unavailable",
        candidateHit: false,
        candidates: [],
        candidatesConsidered: 0,
        lookupMs: 0,
        embeddingMs: 0,
        warnings: [`semantic_cache_cooldown:${this.lastUnavailableError ?? "unavailable"}`],
      };
    }
    try {
      const embeddingStartedAt = Date.now();
      let vectors: number[][];
      try {
        vectors = await this.embeddings.embed([semanticTaskText(input.task)]);
      } catch (error) {
        throw semanticDependencyError("embedding", error, "semantic_embedding_unavailable");
      }
      this.counters.embeddingCalls++;
      const embeddingMs = Date.now() - embeddingStartedAt;
      this.counters.totalEmbeddingLatencyMs += embeddingMs;
      const embedding = vectors[0];
      if (!embedding) throw new Error("semantic_embedding_missing");
      let queried;
      try {
        queried = await this.store.query({
        scope: input.scope,
        embeddingModel: `${this.embeddings.modelId}@${this.embeddings.revision}`,
        embedding,
          topK: this.config.topK,
        });
      } catch (error) {
        throw semanticDependencyError("redis", error, "semantic_redis_unavailable");
      }
      const candidates = queried.filter((candidate) => candidate.similarity >= this.config.minSimilarity);
      const lookupMs = Date.now() - startedAt;
      this.counters.totalLookupLatencyMs += lookupMs;
      if (candidates.length > 0) this.counters.candidateHits++;
      else this.counters.misses++;
      this.clearUnavailable();
      return {
        mode: this.config.mode,
        status: candidates.length > 0 ? "candidate-hit" : "miss",
        candidateHit: candidates.length > 0,
        candidates,
        candidatesConsidered: candidates.length,
        lookupMs,
        embeddingMs,
        warnings: [],
        queryEmbedding: embedding,
      };
    } catch (error) {
      const lookupMs = Date.now() - startedAt;
      this.counters.totalLookupLatencyMs += lookupMs;
      if (!(error instanceof SemanticDependencyUnavailableError) && this.config.failureMode === "closed") throw error;
      const dependency = error instanceof SemanticDependencyUnavailableError ? error.dependency : "unknown";
      if (!(error instanceof SemanticDependencyUnavailableError) && this.config.failureMode === "closed") throw error;
      const unavailable = this.markUnavailable(error, dependency);
      const message = unavailable.message;
      if (this.config.failureMode === "closed") throw unavailable;
      return {
        mode: this.config.mode,
        status: "unavailable",
        candidateHit: false,
        candidates: [],
        candidatesConsidered: 0,
        lookupMs,
        embeddingMs: 0,
        warnings: [`semantic_cache_unavailable:${message}`],
      };
    }
  }

  async put(input: SemanticCacheStoreInput): Promise<SemanticCacheWriteResult> {
    if (this.config.mode === "off") return { status: "disabled", writeMs: 0, embeddingMs: 0 };
    const startedAt = Date.now();
    this.counters.storeAttempts++;
    if (this.inFailureCooldown()) {
      this.counters.cooldownSkips++;
      const cooldownError = new SemanticDependencyUnavailableError(
        this.lastUnavailableDependency ?? "unknown",
        this.lastUnavailableCauseCode ?? "semantic_cache_cooldown",
        `semantic cache dependency remains in cooldown until ${new Date(this.unavailableUntil).toISOString()}`,
      );
      if (this.config.failureMode === "closed") throw cooldownError;
      return {
        status: "failed",
        writeMs: 0,
        embeddingMs: 0,
        warning: `semantic_cache_store_cooldown:${this.lastUnavailableError ?? "unavailable"}`,
      };
    }
    let dependency: SemanticDependency = "redis";
    try {
      const id = candidateId(input);
      let embedding = input.embedding;
      let embeddingMs = 0;
      if (!embedding) {
        dependency = "embedding";
        const embeddingStartedAt = Date.now();
        let vectors: number[][];
        try {
          vectors = await this.embeddings.embed([semanticTaskText(input.task)]);
        } catch (error) {
          throw semanticDependencyError("embedding", error, "semantic_embedding_unavailable");
        }
        this.counters.embeddingCalls++;
        embeddingMs = Date.now() - embeddingStartedAt;
        this.counters.totalEmbeddingLatencyMs += embeddingMs;
        embedding = vectors[0];
      }
      if (!embedding) throw new Error("semantic_embedding_missing");
      dependency = "redis";
      try {
        await this.store.put({
        payload: {
          version: 1,
          candidateId: id,
          createdAt: new Date().toISOString(),
          sourcePackKey: input.sourcePackKey,
          task: structuredClone(input.task),
          scope: structuredClone(input.scope),
          sourceRevisions: structuredClone(input.sourceRevisions),
          components: structuredClone(input.components),
          relevantPaths: [...new Set(input.relevantPaths)].sort(),
        },
        embeddingModel: `${this.embeddings.modelId}@${this.embeddings.revision}`,
        embedding,
          ttlMs: this.config.ttlMs,
        });
      } catch (error) {
        throw semanticDependencyError("redis", error, "semantic_redis_unavailable");
      }
      const writeMs = Date.now() - startedAt;
      this.counters.stores++;
      this.counters.totalWriteLatencyMs += writeMs;
      this.clearUnavailable();
      return { status: "stored", candidateId: id, writeMs, embeddingMs };
    } catch (error) {
      const writeMs = Date.now() - startedAt;
      this.counters.totalWriteLatencyMs += writeMs;
      const unavailable = this.markUnavailable(error, dependency);
      const message = unavailable.message;
      if (this.config.failureMode === "closed") throw unavailable;
      return {
        status: "failed",
        writeMs,
        embeddingMs: 0,
        warning: `semantic_cache_store_failed:${message}`,
      };
    }
  }

  recordOutcome(outcome: SemanticReuseOutcome): void {
    this.counters.componentsConsidered += outcome.componentsConsidered;
    this.counters.componentsReusable += outcome.componentsReusable;
    this.counters.componentsReused += outcome.componentsReused;
    this.counters.componentsRefreshed += outcome.componentsRefreshed;
    this.counters.componentsStale += outcome.componentsStale;
    this.counters.tokensAvoidedEstimate += outcome.tokensAvoidedEstimate;
    this.counters.retrievalCallsAvoided += outcome.retrievalCallsAvoided;
    if (outcome.candidateHit) {
      if (outcome.candidateAccepted) this.counters.acceptedCandidates++;
      else this.counters.rejectedCandidates++;
    }
  }

  getStats(): SemanticCacheStats {
    const outcomes = this.counters.acceptedCandidates + this.counters.rejectedCandidates;
    const unavailableUntil = this.unavailableUntil > Date.now() ? new Date(this.unavailableUntil).toISOString() : null;
    const lastDependency = this.lastUnavailableDependency ?? null;
    const lastErrorCode = this.lastUnavailableErrorCode ?? (lastDependency ? "context_semantic_dependency_unavailable" : null);
    const lastCauseCode = this.lastUnavailableCauseCode ?? (
      lastDependency === "embedding"
        ? "semantic_embedding_transport_unavailable"
        : lastDependency === "redis"
          ? "semantic_redis_unavailable"
          : null
    );
    const lastMessage = this.lastUnavailableError ?? null;
    return {
      stats_contract_version: "semantic-cache-stats/v2",
      incident: {
        dependency: lastDependency,
        error_code: lastErrorCode,
        cause_code: lastCauseCode,
        message: lastMessage,
        unavailable_until: unavailableUntil,
      },
      enabled: this.config.mode !== "off",
      mode: this.config.mode,
      provider: this.embeddings.providerId,
      model: this.embeddings.modelId,
      revision: this.embeddings.revision,
      dimensions: this.embeddings.dimensions,
      lookups: this.counters.lookups,
      candidate_hits: this.counters.candidateHits,
      misses: this.counters.misses,
      store_attempts: this.counters.storeAttempts,
      stores: this.counters.stores,
      errors: this.counters.errors,
      cooldown_skips: this.counters.cooldownSkips,
      last_unavailable_dependency: lastDependency,
      last_error_code: lastErrorCode,
      last_cause_code: lastCauseCode,
      last_error_message: lastMessage,
      unavailable_until: unavailableUntil,
      embedding_calls: this.counters.embeddingCalls,
      accepted_candidates: this.counters.acceptedCandidates,
      rejected_candidates: this.counters.rejectedCandidates,
      candidate_hit_rate: this.counters.lookups === 0 ? 0 : this.counters.candidateHits / this.counters.lookups,
      candidate_acceptance_rate: outcomes === 0 ? 0 : this.counters.acceptedCandidates / outcomes,
      semantic_reuse_potential_rate: this.counters.componentsConsidered === 0
        ? 0
        : this.counters.componentsReusable / this.counters.componentsConsidered,
      semantic_reuse_rate: this.counters.componentsConsidered === 0
        ? 0
        : this.counters.componentsReused / this.counters.componentsConsidered,
      false_semantic_hit_rate: outcomes === 0 ? 0 : this.counters.rejectedCandidates / outcomes,
      components_considered: this.counters.componentsConsidered,
      components_reusable: this.counters.componentsReusable,
      components_reused: this.counters.componentsReused,
      components_refreshed: this.counters.componentsRefreshed,
      components_stale: this.counters.componentsStale,
      retrieval_calls_avoided: this.counters.retrievalCallsAvoided,
      tokens_avoided_estimate: this.counters.tokensAvoidedEstimate,
      total_lookup_latency_ms: this.counters.totalLookupLatencyMs,
      average_lookup_latency_ms: this.counters.lookups === 0
        ? 0
        : this.counters.totalLookupLatencyMs / this.counters.lookups,
      total_embedding_latency_ms: this.counters.totalEmbeddingLatencyMs,
      average_embedding_latency_ms: this.counters.embeddingCalls === 0
        ? 0
        : this.counters.totalEmbeddingLatencyMs / this.counters.embeddingCalls,
      total_write_latency_ms: this.counters.totalWriteLatencyMs,
      average_write_latency_ms: this.counters.storeAttempts === 0
        ? 0
        : this.counters.totalWriteLatencyMs / this.counters.storeAttempts,
    };
  }

  async health(): Promise<SemanticCacheHealth> {
    if (this.config.mode === "off") {
      const disabled = { status: "down" as const, details: { disabled: true } };
      return {
        status: "disabled",
        mode: "off",
        failureMode: this.config.failureMode,
        redis: disabled,
        embedding: disabled,
      };
    }
    const [redis, embedding] = await Promise.all([this.store.health(), this.embeddings.health()]);
    if (redis.status === "up" && embedding.status === "up") {
      this.clearUnavailable();
    } else if (redis.status === "down") {
      const causeCode = typeof redis.details?.cause_code === "string" ? redis.details.cause_code : "semantic_redis_unavailable";
      this.markUnavailable(
        new SemanticDependencyUnavailableError("redis", causeCode, redis.error ?? "semantic_redis_down"),
        "redis",
      );
    } else {
      const causeCode = typeof embedding.details?.cause_code === "string"
        ? embedding.details.cause_code
        : "semantic_embedding_unavailable";
      this.markUnavailable(
        new SemanticDependencyUnavailableError("embedding", causeCode, embedding.error ?? "semantic_embedding_down"),
        "embedding",
      );
    }
    return {
      status: redis.status === "up" && embedding.status === "up" ? "up" : "down",
      mode: this.config.mode,
      failureMode: this.config.failureMode,
      redis,
      embedding,
    };
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
