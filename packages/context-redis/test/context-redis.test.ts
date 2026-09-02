import { describe, expect, it } from "vitest";
import { ContextRedisPool } from "../src/index";

describe("ContextRedisPool", () => {
  it("rejects an empty topology", () => {
    expect(() => new ContextRedisPool({ urls: [] })).toThrow(/context_redis_pool_members_required/);
  });

  it("deduplicates endpoint URLs and assigns stable labels", () => {
    const pool = new ContextRedisPool({
      urls: ["redis://127.0.0.1:6380/", "redis://127.0.0.1:6380", "redis://127.0.0.1:6381"],
    });
    expect(pool.size).toBe(2);
    expect(pool.members.map((member) => member.label)).toEqual(["redis-1", "redis-2"]);
    expect(pool.members.every((member) => member.availability !== undefined)).toBe(true);
  });

  it("shares member availability so recovery can clear an exact-cache circuit", () => {
    const pool = new ContextRedisPool({
      urls: ["redis://127.0.0.1:6380", "redis://127.0.0.1:6381"],
      failureCooldownMs: 30_000,
    });
    const member = pool.members[0]!;
    member.availability!.markUnavailable(30_000);
    expect(member.availability!.isUnavailable()).toBe(true);
    member.availability!.markHealthy();
    expect(member.availability!.isUnavailable()).toBe(false);
    expect(member.availability!.snapshot().lastSuccessAt).not.toBeNull();
  });
});
