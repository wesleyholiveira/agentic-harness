import { describe, expect, it } from "vitest";
import { createCacheKey, stableStringify } from "../src/cache-key";

describe("cache key canonicalization", () => {
  it("is stable across object key order", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
    expect(createCacheKey("x", { b: 2, a: 1 })).toBe(createCacheKey("x", { a: 1, b: 2 }));
  });

  it("keeps namespaces isolated", () => {
    expect(createCacheKey("a", { value: 1 })).not.toBe(createCacheKey("b", { value: 1 }));
  });
});
