import { describe, expect, it } from "vitest";
import {
  RedundantSemanticCandidateStore,
  RedundantSemanticEmbeddingProvider,
  type EmbeddingProviderHealth,
  type SemanticCandidateRecord,
  type SemanticCandidateStore,
  type SemanticCandidateStoreHealth,
  type SemanticEmbeddingProvider,
} from "../src/index";

function record(id = "candidate-b"): SemanticCandidateRecord {
  return {
    candidateId: id,
    distance: 0.1,
    similarity: 0.9,
    payload: {
      version: 1,
      candidateId: id,
      createdAt: new Date(0).toISOString(),
      sourcePackKey: "pack",
      task: {
        text: "task",
        fingerprint: "fp",
        intent: "intent",
        canonicalQuery: "query",
        domains: [],
        files: [],
        symbols: [],
        language: "typescript",
      },
      scope: { projectId: "p", branch: "b", role: "r", stage: "s", schemaVersion: "v" },
      sourceRevisions: { memory: "m", cbm: "c", artifacts: "a" },
      components: {},
      relevantPaths: [],
    },
  };
}

function store(options: {
  query?: () => Promise<SemanticCandidateRecord[]>;
  put?: () => Promise<void>;
  health?: () => Promise<SemanticCandidateStoreHealth>;
} = {}): SemanticCandidateStore {
  return {
    query: options.query ?? (async () => []),
    put: options.put ?? (async () => undefined),
    health: options.health ?? (async () => ({ status: "up", latencyMs: 0 })),
    close: async () => undefined,
  };
}

function embeddingProvider(options: {
  name: string;
  embed?: () => Promise<number[][]>;
  health?: () => Promise<EmbeddingProviderHealth>;
  revision?: string;
}): SemanticEmbeddingProvider {
  return {
    providerId: "huggingface-tei",
    modelId: "model",
    revision: options.revision ?? "revision",
    dimensions: 4,
    embed: options.embed ?? (async () => [[1, 0, 0, 0]]),
    health: options.health ?? (async () => ({ status: "up", details: { member: options.name } })),
  };
}

const queryInput = {
  scope: { projectId: "p", branch: "b", role: "r", stage: "s", schemaVersion: "v" },
  embeddingModel: "model@revision",
  embedding: [1, 0, 0, 0],
  topK: 5,
};

const writeInput = {
  payload: record().payload,
  embeddingModel: "model@revision",
  embedding: [1, 0, 0, 0],
  ttlMs: 60_000,
};

describe("semantic dependency redundancy", () => {
  it("keeps Redis available when one independently writable cache node is down", async () => {
    const pool = new RedundantSemanticCandidateStore([
      store({
        query: async () => Promise.reject(new Error("node-a-down")),
        health: async () => ({ status: "down", error: "node-a-down" }),
      }),
      store({ query: async () => [record()] }),
    ], ["redis-a", "redis-b"], { healthTimeoutMs: 100, minHealthy: 1 });

    expect(await pool.query(queryInput)).toEqual([record()]);
    expect(await pool.health()).toMatchObject({
      status: "up",
      details: {
        topology: "active-active-reconstructible-cache",
        redundancy_state: "degraded",
        pool_size: 2,
        healthy_endpoints: 1,
        required_healthy: 1,
      },
    });
  });

  it("merges bounded member reads so a fast empty mirror cannot mask a reusable candidate", async () => {
    const pool = new RedundantSemanticCandidateStore([
      store({ query: async () => [] }),
      store({ query: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return [record("candidate-from-b")];
      } }),
    ], ["redis-a", "redis-b"], { memberOperationTimeoutMs: 100, minHealthy: 1 });

    expect(await pool.query(queryInput)).toEqual([record("candidate-from-b")]);
  });

  it("prefers the newest payload when mirrors disagree about the same candidate identity", async () => {
    const stale = record("same-candidate");
    const fresh = structuredClone(stale);
    stale.payload.createdAt = new Date(1_000).toISOString();
    fresh.payload.createdAt = new Date(2_000).toISOString();
    fresh.payload.sourcePackKey = "fresh-pack";

    const pool = new RedundantSemanticCandidateStore([
      store({ query: async () => [stale] }),
      store({ query: async () => [fresh] }),
    ], ["redis-a", "redis-b"], { memberOperationTimeoutMs: 100, minHealthy: 1 });

    expect(await pool.query(queryInput)).toEqual([fresh]);
  });

  it("waits for bounded mirror convergence before returning a successful write", async () => {
    let releaseMirror: (() => void) | undefined;
    const mirrorBlocked = new Promise<void>((resolve) => { releaseMirror = resolve; });
    let completed = false;
    const pool = new RedundantSemanticCandidateStore([
      store({ put: async () => undefined }),
      store({ put: async () => mirrorBlocked }),
    ], ["redis-a", "redis-b"], { memberOperationTimeoutMs: 100, minHealthy: 1 });

    const write = pool.put(writeInput).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(completed).toBe(false);
    releaseMirror?.();
    await write;
    expect(completed).toBe(true);
  });

  it("bounds a hung Redis member while preserving a survivor result", async () => {
    const never = new Promise<SemanticCandidateRecord[]>(() => undefined);
    const pool = new RedundantSemanticCandidateStore([
      store({ query: async () => never }),
      store({ query: async () => [record("survivor")] }),
    ], ["redis-a", "redis-b"], { memberOperationTimeoutMs: 20, minHealthy: 1 });

    const startedAt = Date.now();
    expect(await pool.query(queryInput)).toEqual([record("survivor")]);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("accepts a Redis mirror write when at least one cache node succeeds and fails typed only when all fail", async () => {
    let survivorWrites = 0;
    const available = new RedundantSemanticCandidateStore([
      store({ put: async () => Promise.reject(new Error("node-a-down")) }),
      store({ put: async () => { survivorWrites++; } }),
    ], ["redis-a", "redis-b"]);
    await expect(available.put(writeInput)).resolves.toBeUndefined();
    expect(survivorWrites).toBe(1);

    const unavailable = new RedundantSemanticCandidateStore([
      store({ query: async () => Promise.reject(new Error("node-a-down")) }),
      store({ query: async () => Promise.reject(new Error("node-b-down")) }),
    ]);
    await expect(unavailable.query(queryInput)).rejects.toMatchObject({
      code: "context_semantic_dependency_unavailable",
      dependency: "redis",
      causeCode: "semantic_redis_unavailable",
      retryable: true,
    });
  });

  it("fails over TEI embeddings while preserving the exact model identity", async () => {
    const pool = new RedundantSemanticEmbeddingProvider([
      embeddingProvider({
        name: "tei-a",
        embed: async () => Promise.reject(new TypeError("fetch failed")),
        health: async () => ({ status: "down", error: "fetch failed" }),
      }),
      embeddingProvider({ name: "tei-b", embed: async () => [[0, 1, 0, 0]] }),
    ], ["tei-a", "tei-b"], { healthTimeoutMs: 100, minHealthy: 1 });

    expect(pool.providerId).toBe("huggingface-tei");
    expect(pool.modelId).toBe("model");
    expect(pool.revision).toBe("revision");
    expect(await pool.embed(["hello"])).toEqual([[0, 1, 0, 0]]);
    expect(await pool.health()).toMatchObject({
      status: "up",
      details: {
        topology: "stateless-active-active",
        redundancy_state: "degraded",
        pool_size: 2,
        healthy_endpoints: 1,
      },
    });
  });

  it("rejects TEI pool members with a different model revision", () => {
    expect(() => new RedundantSemanticEmbeddingProvider([
      embeddingProvider({ name: "tei-a" }),
      embeddingProvider({ name: "tei-b", revision: "other" }),
    ])).toThrow(/semantic_embedding_pool_identity_mismatch/);
  });
});
