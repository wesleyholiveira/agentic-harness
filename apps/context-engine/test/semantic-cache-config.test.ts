import { describe, expect, it } from "vitest";
import { createContextSemanticCache, resolveContextSemanticEndpoints } from "../src/semantic-cache-config";

function expectHttpEndpoint(actual: string, hostname: string, effectivePort: number): void {
  const parsed = new URL(actual);
  expect(parsed.protocol).toBe("http:");
  expect(parsed.hostname).toBe(hostname);
  expect(parsed.port || "80").toBe(String(effectivePort));
}

describe("Context Engine semantic cache configuration", () => {
  it("resolves Compose DNS to host loopback outside containers", () => {
    const resolved = resolveContextSemanticEndpoints({
      CONTEXT_SEMANTIC_NETWORK_MODE: "host",
      CONTEXT_SEMANTIC_REDIS_URL: "redis://context-semantic-redis:6379",
      CONTEXT_SEMANTIC_REDIS_HOST: "127.0.0.1",
      CONTEXT_SEMANTIC_REDIS_HOST_PORT: "6380",
      CONTEXT_SEMANTIC_EMBEDDING_BASE_URL: "http://context-embeddings:80",
      CONTEXT_SEMANTIC_EMBEDDING_HOST: "127.0.0.1",
      CONTEXT_SEMANTIC_EMBEDDING_HOST_PORT: "8791",
    });
    expect(resolved.networkMode).toBe("host");
    expect(resolved.redisUrl).toBe("redis://127.0.0.1:6380");
    expect(resolved.embeddingBaseUrl).toBe("http://127.0.0.1:8791");
  });

  it("preserves Compose DNS inside containers", () => {
    const resolved = resolveContextSemanticEndpoints({ CONTEXT_SEMANTIC_NETWORK_MODE: "container" });
    expect(resolved.networkMode).toBe("container");
    expect(resolved.redisUrl).toBe("redis://context-semantic-redis:6379");
    expectHttpEndpoint(resolved.embeddingBaseUrl, "context-embeddings", 80);
  });

  it("rewrites host loopback endpoints back to Compose DNS inside containers", () => {
    const resolved = resolveContextSemanticEndpoints({
      CONTEXT_SEMANTIC_NETWORK_MODE: "container",
      CONTEXT_SEMANTIC_REDIS_URL: "redis://127.0.0.1:6380",
      CONTEXT_SEMANTIC_REDIS_HOST: "127.0.0.1",
      CONTEXT_SEMANTIC_EMBEDDING_BASE_URL: "http://localhost:8791",
      CONTEXT_SEMANTIC_EMBEDDING_HOST: "127.0.0.1",
    });
    expect(resolved.redisUrl).toBe("redis://context-semantic-redis:6379");
    expectHttpEndpoint(resolved.embeddingBaseUrl, "context-embeddings", 80);
  });

  it("preserves explicitly external semantic endpoints in container mode", () => {
    const resolved = resolveContextSemanticEndpoints({
      CONTEXT_SEMANTIC_NETWORK_MODE: "container",
      CONTEXT_SEMANTIC_REDIS_URL: "rediss://redis.example.internal:6380",
      CONTEXT_SEMANTIC_EMBEDDING_BASE_URL: "https://embeddings.example.internal/v1",
    });
    expect(resolved.redisUrl).toBe("rediss://redis.example.internal:6380");
    expect(resolved.embeddingBaseUrl).toBe("https://embeddings.example.internal/v1");
  });

  it("allows deterministic embeddings only under the explicit test seam", () => {
    expect(() => createContextSemanticCache(process.cwd(), {
      CONTEXT_SEMANTIC_CACHE_MODE: "off",
      CONTEXT_SEMANTIC_EMBEDDING_PROVIDER: "deterministic",
    })).toThrow(/context_semantic_embedding_provider_invalid/);
    const resolved = createContextSemanticCache(process.cwd(), {
      CONTEXT_SEMANTIC_CACHE_MODE: "off",
      CONTEXT_SEMANTIC_EMBEDDING_PROVIDER: "deterministic",
      AGENT_HARNESS_CONTEXT_SEMANTIC_TEST_MODE: "1",
      CONTEXT_SEMANTIC_NETWORK_MODE: "host",
    });
    expect(resolved.cache.embeddings.providerId).toBe("deterministic-test-double");
  });

  it("rejects observe plus fail-closed because it cannot safely preserve observation semantics", () => {
    expect(() => createContextSemanticCache(process.cwd(), {
      CONTEXT_SEMANTIC_CACHE_MODE: "observe",
      CONTEXT_SEMANTIC_CACHE_FAILURE_MODE: "closed",
      CONTEXT_SEMANTIC_NETWORK_MODE: "host",
    })).toThrow(/context_semantic_observe_requires_failure_open/);
  });
  it("resolves the canonical two-member pools when no explicit endpoint override is provided", () => {
    const resolved = resolveContextSemanticEndpoints({ CONTEXT_SEMANTIC_NETWORK_MODE: "host" });
    expect(resolved.redisUrls).toEqual(["redis://127.0.0.1:6380", "redis://127.0.0.1:6381"]);
    expect(resolved.embeddingBaseUrls).toEqual(["http://127.0.0.1:8791", "http://127.0.0.1:8792"]);
  });

  it("rewrites explicit endpoint pools symmetrically between host and Compose networking", () => {
    const host = resolveContextSemanticEndpoints({
      CONTEXT_SEMANTIC_NETWORK_MODE: "host",
      CONTEXT_SEMANTIC_REDIS_URLS: "redis://context-semantic-redis:6379,redis://context-semantic-redis-secondary:6379",
      CONTEXT_SEMANTIC_EMBEDDING_BASE_URLS: "http://context-embeddings:80,http://context-embeddings-secondary:80",
    });
    expect(host.redisUrls).toEqual(["redis://127.0.0.1:6380", "redis://127.0.0.1:6381"]);
    expect(host.embeddingBaseUrls).toEqual(["http://127.0.0.1:8791", "http://127.0.0.1:8792"]);

    const container = resolveContextSemanticEndpoints({
      CONTEXT_SEMANTIC_NETWORK_MODE: "container",
      CONTEXT_SEMANTIC_REDIS_URLS: "redis://127.0.0.1:6380,redis://127.0.0.1:6381",
      CONTEXT_SEMANTIC_EMBEDDING_BASE_URLS: "http://127.0.0.1:8791,http://127.0.0.1:8792",
    });
    expect(container.redisUrls).toEqual(["redis://context-semantic-redis:6379", "redis://context-semantic-redis-secondary:6379"]);
    expect(container.embeddingBaseUrls).toEqual(["http://context-embeddings", "http://context-embeddings-secondary"]);
  });

  it("refuses enforce/closed on a singleton dependency topology by default", () => {
    expect(() => createContextSemanticCache(process.cwd(), {
      CONTEXT_SEMANTIC_CACHE_MODE: "enforce",
      CONTEXT_SEMANTIC_CACHE_FAILURE_MODE: "closed",
      CONTEXT_SEMANTIC_NETWORK_MODE: "host",
      CONTEXT_SEMANTIC_REDIS_URL: "redis://127.0.0.1:6380",
      CONTEXT_SEMANTIC_EMBEDDING_BASE_URL: "http://127.0.0.1:8791",
    })).toThrow(/context_semantic_closed_redundancy_required:redis:1:2/);
  });

  it("accepts enforce/closed when both dependency pools meet the configured redundancy floor", () => {
    const resolved = createContextSemanticCache(process.cwd(), {
      CONTEXT_SEMANTIC_CACHE_MODE: "enforce",
      CONTEXT_SEMANTIC_CACHE_FAILURE_MODE: "closed",
      CONTEXT_SEMANTIC_NETWORK_MODE: "host",
      CONTEXT_SEMANTIC_REDIS_URLS: "redis://127.0.0.1:6380,redis://127.0.0.1:6381",
      CONTEXT_SEMANTIC_EMBEDDING_BASE_URLS: "http://127.0.0.1:8791,http://127.0.0.1:8792",
    });
    expect(resolved.redisUrls).toHaveLength(2);
    expect(resolved.embeddingBaseUrls).toHaveLength(2);
  });

});
