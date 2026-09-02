import { describe, expect, it } from "vitest";
import { L1SessionCache } from "../src/l1-session";

describe("L1SessionCache", () => {
  it("stores and retrieves a value by key", () => {
    const cache = new L1SessionCache(60_000);
    cache.set("key1", { data: "hello" }, []);
    expect(cache.get("key1")).toEqual({ data: "hello" });
  });

  it("returns undefined for missing key", () => {
    const cache = new L1SessionCache(60_000);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("returns undefined for expired key", () => {
    const cache = new L1SessionCache(0);
    cache.set("key1", "value", []);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("invalidates by file hash", () => {
    const cache = new L1SessionCache(60_000);
    cache.set("key1", "value", ["hash_abc"]);
    cache.invalidate("hash_abc");
    expect(cache.get("key1")).toBeUndefined();
  });

  it("does not invalidate entries with different deps", () => {
    const cache = new L1SessionCache(60_000);
    cache.set("key1", "value1", ["hash_abc"]);
    cache.set("key2", "value2", ["hash_xyz"]);
    cache.invalidate("hash_abc");
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBe("value2");
  });

  it("clears all entries", () => {
    const cache = new L1SessionCache(60_000);
    cache.set("key1", "value1", []);
    cache.set("key2", "value2", []);
    cache.clear();
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBeUndefined();
  });
});

it("deletes an entry by key", () => {
  const cache = new L1SessionCache(60_000);
  cache.set("key1", "value", []);
  expect(cache.delete("key1")).toBe(true);
  expect(cache.get("key1")).toBeUndefined();
});
