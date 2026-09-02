import { describe, expect, it } from "vitest";
import { RedisExactCache, ContextCacheDependencyUnavailableError } from "../src/index";
import type { RedisCommandClient, RedisReply } from "@agent-harness/context-semantic-cache";
import type { ContextRedisMember, ContextRedisMemberAvailability } from "@agent-harness/context-redis";

class FakeRedis implements RedisCommandClient {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sets = new Map<string, Set<string>>();
  down = false;
  hang = false;
  commandCount = 0;
  async command(parts: Array<string | Buffer>): Promise<RedisReply> {
    this.commandCount++;
    if (this.hang) return await new Promise<RedisReply>(() => undefined);
    if (this.down) throw new Error("redis-down");
    const a = parts.map((part) => Buffer.isBuffer(part) ? part.toString("utf8") : part);
    const cmd = a[0]?.toUpperCase();
    if (cmd === "PING") return "PONG";
    if (cmd === "GET") return this.strings.get(a[1]!) ?? null;
    if (cmd === "SET") { this.strings.set(a[1]!, a[2]!); return "OK"; }
    if (cmd === "DEL") { const existed = Number(this.strings.delete(a[1]!) || this.sets.delete(a[1]!)); return existed; }
    if (cmd === "HSET") { const h=this.hashes.get(a[1]!)??new Map(); this.hashes.set(a[1]!,h); const old=h.has(a[2]!); h.set(a[2]!,a[3]!); return old?0:1; }
    if (cmd === "HSETNX") { const h=this.hashes.get(a[1]!)??new Map(); this.hashes.set(a[1]!,h); if(h.has(a[2]!)) return 0; h.set(a[2]!,a[3]!); return 1; }
    if (cmd === "HGET") return this.hashes.get(a[1]!)?.get(a[2]!) ?? null;
    if (cmd === "SADD") { const s=this.sets.get(a[1]!)??new Set(); this.sets.set(a[1]!,s); const n=s.size; s.add(a[2]!); return s.size-n; }
    if (cmd === "SREM") { const s=this.sets.get(a[1]!); return s?.delete(a[2]!) ? 1 : 0; }
    if (cmd === "SMEMBERS") return [...(this.sets.get(a[1]!) ?? [])];
    if (cmd === "PEXPIRE") return 1;
    throw new Error(`unsupported:${cmd}`);
  }
  async close() {}
  redactedUrl() { return "redis://fake"; }
}

function members(...clients: FakeRedis[]): ContextRedisMember[] {
  return clients.map((client,index)=>({label:`redis-${index+1}`,url:`redis://fake-${index+1}`,client}));
}

class FakeAvailability implements ContextRedisMemberAvailability {
  unavailableUntil=0;
  lastFailureAt:number|null=null;
  lastSuccessAt:number|null=null;
  isUnavailable(now=Date.now()){return now<this.unavailableUntil;}
  markUnavailable(cooldownMs=30_000){const now=Date.now();this.lastFailureAt=now;this.unavailableUntil=now+cooldownMs;}
  markHealthy(){this.lastSuccessAt=Date.now();this.unavailableUntil=0;}
  snapshot(){return {unavailableUntil:this.unavailableUntil,lastFailureAt:this.lastFailureAt,lastSuccessAt:this.lastSuccessAt};}
}

describe("RedisExactCache", () => {
  it("serves a replicated exact hit and detects hash staleness", async () => {
    const a=new FakeRedis(), b=new FakeRedis();
    const cache=new RedisExactCache({members:members(a,b),failureMode:"closed"});
    await cache.set("k", {ok:true}, ["h1"], 60_000);
    expect(await cache.get("k")).toMatchObject({value:{ok:true},stale:false});
    await cache.updateHash("h1","h2");
    expect((await cache.get("k"))?.stale).toBe(true);
  });

  it("turns a single-member outage into a conservative MISS, not an exact HIT", async () => {
    const a=new FakeRedis(), b=new FakeRedis();
    const cache=new RedisExactCache({members:members(a,b),failureMode:"closed"});
    await cache.set("k", "value", [], 60_000);
    a.down=true;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("fails typed when the whole Redis pool is unavailable in closed mode", async () => {
    const a=new FakeRedis(), b=new FakeRedis(); a.down=b.down=true;
    const cache=new RedisExactCache({
      members:members(a,b),
      failureMode:"closed",
      memberOperationTimeoutMs:10,
      memberFailureCooldownMs:1_000,
    });
    await expect(cache.get("k")).rejects.toBeInstanceOf(ContextCacheDependencyUnavailableError);
    // Once both member circuits are open, subsequent calls must remain
    // fail-closed rather than being misclassified as an ordinary cache MISS.
    await expect(cache.get("k")).rejects.toBeInstanceOf(ContextCacheDependencyUnavailableError);
  });

  it("does not let a recovered stale replica authorize an exact HIT", async () => {
    const a=new FakeRedis(), b=new FakeRedis();
    const cache=new RedisExactCache({members:members(a,b),failureMode:"closed"});
    await cache.set("k", "old", ["h1"], 60_000);

    a.down=true;
    await cache.updateHash("h1", "h2");
    a.down=false;

    // A still has the old h1→h1 registry while B has h1→h2. Exact cache
    // must conservatively reject the disagreement rather than resurrect old.
    expect(await cache.get("k")).toBeUndefined();
  });

  it("bounds a hanging member once and then fast-misses while its circuit is open", async () => {
    const a=new FakeRedis(), b=new FakeRedis();
    const cache=new RedisExactCache({
      members:members(a,b),
      failureMode:"closed",
      memberOperationTimeoutMs:10,
      memberFailureCooldownMs:1_000,
    });
    await cache.set("k", "value", [], 60_000);

    a.hang=true;
    const firstStarted=Date.now();
    expect(await cache.get("k")).toBeUndefined();
    const firstElapsed=Date.now()-firstStarted;
    expect(firstElapsed).toBeLessThan(250);
    const commandsAfterFirst=a.commandCount;

    const secondStarted=Date.now();
    expect(await cache.get("k")).toBeUndefined();
    const secondElapsed=Date.now()-secondStarted;
    expect(secondElapsed).toBeLessThan(50);
    expect(a.commandCount).toBe(commandsAfterFirst);

    // Degraded exact writes remain available through the surviving member and
    // do not re-probe the open-circuit member on every write.
    await cache.set("k2", "survivor", [], 60_000);
    expect(b.strings.size).toBeGreaterThan(0);
    expect(a.commandCount).toBe(commandsAfterFirst);
  });

  it("lets shared Redis health clear an exact circuit immediately after member recovery", async () => {
    const a=new FakeRedis(), b=new FakeRedis();
    const availabilityA=new FakeAvailability();
    const availabilityB=new FakeAvailability();
    const cache=new RedisExactCache({
      members:[
        {label:"redis-1",url:"redis://fake-1",client:a,availability:availabilityA},
        {label:"redis-2",url:"redis://fake-2",client:b,availability:availabilityB},
      ],
      failureMode:"closed",
      memberOperationTimeoutMs:10,
      memberFailureCooldownMs:30_000,
    });
    await cache.set("k", "value", [], 60_000);
    a.hang=true;
    expect(await cache.get("k")).toBeUndefined();
    expect(availabilityA.isUnavailable()).toBe(true);

    a.hang=false;
    // This models a successful semantic Redis query or context_health PING on
    // the same process-scoped pool member after the container is restored.
    availabilityA.markHealthy();
    expect(await cache.get("k")).toMatchObject({value:"value",stale:false});
  });
});
