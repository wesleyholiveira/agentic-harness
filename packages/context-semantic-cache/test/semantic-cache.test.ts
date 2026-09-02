import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicSemanticEmbeddingProvider,
  RedisSemanticCandidateStore,
  SemanticContextCache,
  TeiEmbeddingProvider,
  parseRedisReply,
  type RedisCommandClient,
  type RedisReply,
  type SemanticCandidateRecord,
  type SemanticCandidateStore,
  type SemanticCandidateStoreHealth,
} from "../src/index";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function scope() {
  return { projectId: "p", branch: "b", role: "developer", stage: "implementation", schemaVersion: "v1" };
}

function task(text = "optimize semantic context cache") {
  return {
    text,
    fingerprint: `fp:${text}`,
    intent: "optimize",
    canonicalQuery: "cache context semantic",
    domains: ["context-engine", "cache"],
    files: [],
    symbols: [],
    language: "typescript",
  };
}

class MemoryStore implements SemanticCandidateStore {
  candidate: SemanticCandidateRecord | undefined;
  puts = 0;
  queries = 0;
  async query(): Promise<SemanticCandidateRecord[]> {
    this.queries++;
    return this.candidate ? [this.candidate] : [];
  }
  async put(input: Parameters<SemanticCandidateStore["put"]>[0]): Promise<void> {
    this.puts++;
    this.candidate = { candidateId: input.payload.candidateId, payload: input.payload, distance: 0.05, similarity: 0.95 };
  }
  async health(): Promise<SemanticCandidateStoreHealth> { return { status: "up", latencyMs: 0 }; }
  async close(): Promise<void> {}
}

describe("semantic candidate cache", () => {
  it("produces deterministic normalized embeddings for the test double", async () => {
    const provider = new DeterministicSemanticEmbeddingProvider(128);
    const [a, b, c] = await provider.embed([
      "Optimize semantic cache in Context Engine",
      "optimize semantic cache in context engine",
      "concurrent worker scheduling",
    ]);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(128);
  });

  it("reuses a lookup embedding when storing the candidate", async () => {
    const store = new MemoryStore();
    const provider = new DeterministicSemanticEmbeddingProvider(128);
    const cache = new SemanticContextCache({
      mode: "observe", failureMode: "open", minSimilarity: 0.8, topK: 5,
      ttlMs: 60_000, failureCooldownMs: 1_000, projectId: "p", branch: "b", schemaVersion: "v1", cwd: process.cwd(),
    }, store, provider);
    const lookup = await cache.lookup({ task: task(), scope: scope(), sourceRevisions: { memory: "m1", cbm: "c1", artifacts: "a1" } });
    expect(lookup.status).toBe("miss");
    expect(lookup.queryEmbedding).toBeDefined();
    const before = cache.getStats().embedding_calls;
    const write = await cache.put({
      task: task(), embedding: lookup.queryEmbedding, scope: scope(), sourceRevisions: { memory: "m1", cbm: "c1", artifacts: "a1" },
      sourcePackKey: "pack:1", components: {}, relevantPaths: [],
    });
    expect(write.status).toBe("stored");
    expect(cache.getStats().embedding_calls).toBe(before);
  });

  it("deduplicates transient run identities into one semantic candidate key", async () => {
    const store = new MemoryStore();
    const cache = new SemanticContextCache({
      mode: "observe", failureMode: "open", minSimilarity: 0.8, topK: 5,
      ttlMs: 60_000, failureCooldownMs: 1_000, projectId: "p", branch: "b", schemaVersion: "v1", cwd: process.cwd(),
    }, store, new DeterministicSemanticEmbeddingProvider(128));
    const firstTask = {
      ...task("Investigate cache regression Qualification run-11111111-1111-4111-8111-111111111111"),
      fingerprint: "raw-fingerprint-1",
      canonicalQuery: "cache regression run-11111111-1111-4111-8111-111111111111",
    };
    const secondTask = {
      ...task("Investigate cache regression Qualification run-22222222-2222-4222-8222-222222222222"),
      fingerprint: "raw-fingerprint-2",
      canonicalQuery: "cache regression run-22222222-2222-4222-8222-222222222222",
    };

    const first = await cache.put({
      task: firstTask, scope: scope(), sourceRevisions: { memory: "m1", cbm: "c1", artifacts: "a1" },
      sourcePackKey: "pack:raw:1", components: {}, relevantPaths: [],
    });
    const second = await cache.put({
      task: secondTask, scope: scope(), sourceRevisions: { memory: "m2", cbm: "c2", artifacts: "a2" },
      sourcePackKey: "pack:raw:2", components: {}, relevantPaths: [],
    });

    expect(first.candidateId).toBeDefined();
    expect(second.candidateId).toBe(first.candidateId);
  });

  it("fails open and enters a bounded cooldown", async () => {
    const store: SemanticCandidateStore = {
      query: async () => { throw new Error("redis-down"); },
      put: async () => { throw new Error("redis-down"); },
      health: async () => ({ status: "down", error: "redis-down" }),
      close: async () => undefined,
    };
    const cache = new SemanticContextCache({
      mode: "observe", failureMode: "open", minSimilarity: 0.8, topK: 5,
      ttlMs: 60_000, failureCooldownMs: 60_000, projectId: "p", branch: "b", schemaVersion: "v1", cwd: process.cwd(),
    }, store, new DeterministicSemanticEmbeddingProvider(128));
    const first = await cache.lookup({ task: task(), scope: scope(), sourceRevisions: { memory: "m1", cbm: "c1", artifacts: "a1" } });
    const second = await cache.lookup({ task: task("paraphrase"), scope: scope(), sourceRevisions: { memory: "m1", cbm: "c1", artifacts: "a1" } });
    expect(first.status).toBe("unavailable");
    expect(second.status).toBe("unavailable");
    expect(second.warnings[0]).toMatch(/semantic_cache_cooldown/);
    expect(cache.getStats().cooldown_skips).toBe(1);
  });

  it("counts a health-detected outage once and keeps cooldown skips separate", async () => {
    let healthy = false;
    const store: SemanticCandidateStore = {
      query: async () => { throw new Error("redis-down"); },
      put: async () => { throw new Error("redis-down"); },
      health: async () => healthy
        ? ({ status: "up", latencyMs: 0 })
        : ({ status: "down", error: "redis-down" }),
      close: async () => undefined,
    };
    const cache = new SemanticContextCache({
      mode: "enforce", failureMode: "open", minSimilarity: 0.8, topK: 5,
      ttlMs: 60_000, failureCooldownMs: 60_000, projectId: "p", branch: "b", schemaVersion: "v1", cwd: process.cwd(),
    }, store, new DeterministicSemanticEmbeddingProvider(128));

    expect((await cache.health()).status).toBe("down");
    expect(cache.getStats().errors).toBe(1);
    expect((await cache.health()).status).toBe("down");
    expect(cache.getStats().errors).toBe(1);

    const duringCooldown = await cache.lookup({
      task: task("health detected outage"),
      scope: scope(),
      sourceRevisions: { memory: "m1", cbm: "c1", artifacts: "a1" },
    });
    expect(duringCooldown.status).toBe("unavailable");
    expect(duringCooldown.warnings[0]).toMatch(/semantic_cache_cooldown/);
    expect(cache.getStats().cooldown_skips).toBe(1);
    expect(cache.getStats().errors).toBe(1);

    healthy = true;
    expect((await cache.health()).status).toBe("up");
    healthy = false;
    expect((await cache.health()).status).toBe("down");
    expect(cache.getStats().errors).toBe(2);
  });


  it("preserves closed semantics during cooldown and recovers after healthy probe", async () => {
    let healthy = false;
    const store: SemanticCandidateStore = {
      query: async () => healthy ? [] : Promise.reject(new Error("redis-down")),
      put: async () => undefined,
      health: async () => healthy
        ? ({ status: "up", latencyMs: 0 })
        : ({ status: "down", error: "redis-down" }),
      close: async () => undefined,
    };
    const cache = new SemanticContextCache({
      mode: "enforce", failureMode: "closed", minSimilarity: 0.8, topK: 5,
      ttlMs: 60_000, failureCooldownMs: 60_000, projectId: "p", branch: "b", schemaVersion: "v1", cwd: process.cwd(),
    }, store, new DeterministicSemanticEmbeddingProvider(128));

    expect((await cache.health()).status).toBe("down");
    expect(cache.getStats().errors).toBe(1);
    await expect(cache.lookup({
      task: task("closed cooldown"),
      scope: scope(),
      sourceRevisions: { memory: "m1", cbm: "c1", artifacts: "a1" },
    })).rejects.toMatchObject({
      code: "context_semantic_dependency_unavailable",
      dependency: "redis",
      retryable: true,
    });
    expect(cache.getStats().cooldown_skips).toBe(1);
    expect(cache.getStats().errors).toBe(1);

    healthy = true;
    expect((await cache.health()).status).toBe("up");
    const recovered = await cache.lookup({
      task: task("closed recovered"),
      scope: scope(),
      sourceRevisions: { memory: "m1", cbm: "c1", artifacts: "a1" },
    });
    expect(recovered.status).toBe("miss");
    expect(cache.getStats()).toMatchObject({
      stats_contract_version: "semantic-cache-stats/v2",
      incident: {
        dependency: "redis",
        error_code: "context_semantic_dependency_unavailable",
        cause_code: "semantic_redis_unavailable",
        unavailable_until: null,
      },
      last_unavailable_dependency: "redis",
      last_error_code: "context_semantic_dependency_unavailable",
      last_cause_code: "semantic_redis_unavailable",
      unavailable_until: null,
    });
  });

  it("classifies TEI transport outages with a specific retryable dependency error", async () => {
    const provider = new TeiEmbeddingProvider({
      baseUrl: "http://127.0.0.1:1", modelId: "m", revision: "r", dimensions: 4, timeoutMs: 250,
    });
    await expect(provider.embed(["hello"])).rejects.toMatchObject({
      code: "context_semantic_dependency_unavailable",
      dependency: "embedding",
      causeCode: "semantic_embedding_transport_unavailable",
      retryable: true,
    });
    const health = await provider.health();
    expect(health.status).toBe("down");
    expect(health.error).toMatch(/semantic_embedding_transport_unavailable/);
  });

  it("parses RESP bulk and array replies without corrupting binary payloads", () => {
    const parsed = parseRedisReply(Buffer.from("*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n"));
    expect(parsed?.nextOffset).toBe(22);
    expect((parsed?.value as Buffer[]).map((value) => value.toString("utf8"))).toEqual(["foo", "bar"]);
  });

  it("builds a filtered HNSW KNN query and TTL write", async () => {
    const commands: Array<Array<string | Buffer>> = [];
    const client: RedisCommandClient = {
      async command(parts) {
        commands.push(parts);
        const command = String(parts[0]);
        if (command === "FT.CREATE") return "OK";
        if (command === "FT.SEARCH") return [0] satisfies RedisReply[];
        if (command === "HSET" || command === "PEXPIRE") return 1;
        if (command === "PING") return "PONG";
        return "OK";
      },
      async close() {},
      redactedUrl() { return "redis://127.0.0.1:6380/"; },
    };
    const store = new RedisSemanticCandidateStore({
      url: "redis://127.0.0.1:6380", embeddingModel: "m@r", dimensions: 4, client,
    });
    await store.query({ scope: scope(), embeddingModel: "m@r", embedding: [1, 0, 0, 0], topK: 3 });
    const create = commands.find((parts) => parts[0] === "FT.CREATE");
    expect(String(create?.[1])).toContain(":index:v2:");
    const search = commands.find((parts) => parts[0] === "FT.SEARCH");
    expect(search?.join(" ")).toContain("KNN 3 @embedding");
    expect(search?.join(" ")).toContain("@project_tag");
    expect(search?.join(" ")).toContain("@branch_tag");
    expect(search?.join(" ")).toContain("@role_tag");
    expect(search?.join(" ")).toContain("@stage_tag");
    expect(search?.join(" ")).toContain("@schema_tag");
  });

  it("uses the TEI /embed endpoint and validates dimensions", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200).end("ok");
        return;
      }
      if (request.url === "/embed") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify([[1, 0, 0, 0]]));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_address_missing");
    const provider = new TeiEmbeddingProvider({
      baseUrl: `http://127.0.0.1:${address.port}`, modelId: "m", revision: "r", dimensions: 4, timeoutMs: 1_000,
    });
    expect(await provider.embed(["hello"])).toEqual([[1, 0, 0, 0]]);
    expect((await provider.health()).status).toBe("up");
  });

  it("preserves structured dependency identity across package boundaries and stats", async () => {
    const cache = new SemanticContextCache(
      {
        mode: "enforce", failureMode: "closed", projectId: "p", branch: "b", schemaVersion: "s",
        minSimilarity: 0.88, topK: 5, ttlMs: 60_000, failureCooldownMs: 30_000, maxPayloadBytes: 1_000_000,
      },
      {
        async query() { return []; },
        async put() {},
        async health() { return { status: "up" as const }; },
        async close() {},
      },
      {
        providerId: "tei", modelId: "m", revision: "r", dimensions: 384,
        async embed() {
          throw Object.assign(new Error("transport down"), {
            code: "context_semantic_dependency_unavailable",
            dependency: "embedding",
            causeCode: "semantic_embedding_transport_unavailable",
            retryable: true,
          });
        },
        async health() { return { status: "up" as const }; },
      },
    );

    await expect(cache.lookup({
      task: { intent: "i", domains: [], language: "en", files: [], symbols: [], canonicalQuery: "q", text: "t", fingerprint: "f" },
      scope: { projectId: "p", branch: "b", role: "r", stage: "s", schemaVersion: "v" },
      sourceRevisions: { memory: "m", cbm: "c" },
    })).rejects.toMatchObject({
      code: "context_semantic_dependency_unavailable",
      dependency: "embedding",
      causeCode: "semantic_embedding_transport_unavailable",
      retryable: true,
    });

    expect(cache.getStats()).toMatchObject({
      stats_contract_version: "semantic-cache-stats/v2",
      incident: {
        dependency: "embedding",
        error_code: "context_semantic_dependency_unavailable",
        cause_code: "semantic_embedding_transport_unavailable",
      },
      last_unavailable_dependency: "embedding",
      last_error_code: "context_semantic_dependency_unavailable",
      last_cause_code: "semantic_embedding_transport_unavailable",
    });

    // Recovery clears the active cooldown/readiness boundary, but the most
    // recent incident remains queryable through context_stats for operations.
    expect((await cache.health()).status).toBe("up");
    expect(cache.getStats()).toMatchObject({
      incident: {
        dependency: "embedding",
        error_code: "context_semantic_dependency_unavailable",
        cause_code: "semantic_embedding_transport_unavailable",
        unavailable_until: null,
      },
      last_unavailable_dependency: "embedding",
      last_error_code: "context_semantic_dependency_unavailable",
      last_cause_code: "semantic_embedding_transport_unavailable",
      unavailable_until: null,
    });
  });

});
