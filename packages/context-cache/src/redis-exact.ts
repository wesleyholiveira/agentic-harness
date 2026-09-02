import type { ContextRedisMember } from "@agent-harness/context-redis";
import type { RedisReply } from "@agent-harness/context-semantic-cache";
import type { L2GetResult, PersistentContextCache } from "./types";

export class ContextCacheDependencyUnavailableError extends Error {
  readonly code = "context_semantic_dependency_unavailable";
  readonly dependency = "redis";
  readonly retryable = true;
  readonly causeCode = "context_exact_redis_unavailable";

  constructor(message = "context_exact_redis_unavailable") {
    super(message);
    this.name = "ContextCacheDependencyUnavailableError";
  }
}

interface StoredExactEntry {
  version: 1;
  value: unknown;
  deps: string[];
  createdAt: number;
  ttlMs: number;
}

export interface RedisExactCacheOptions {
  members: ContextRedisMember[];
  namespace?: string;
  failureMode?: "open" | "closed";
  /**
   * Per-member deadline for exact-cache operations. Exact L2 is deliberately
   * stricter than semantic reuse and must not let one failed replica consume
   * the full Context Pack request budget repeatedly.
   */
  memberOperationTimeoutMs?: number;
  /**
   * Local circuit-open interval after a member operation fails/times out.
   * While open, exact L2 treats the pool as degraded and returns a
   * conservative MISS instead of probing the failed member on every lookup.
   */
  memberFailureCooldownMs?: number;
}

function asText(value: RedisReply): string | undefined {
  if (value === null) return undefined;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}

function asInteger(value: RedisReply): number {
  const text = asText(value);
  const parsed = text === undefined ? 0 : Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function asStringArray(value: RedisReply): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asText(entry)).filter((entry): entry is string => entry !== undefined);
}

function normalizeNamespace(value: string | undefined): string {
  const normalized = value?.trim().replace(/:+$/, "") || "agent:harness:context:exact:v1";
  if (!normalized) throw new Error("context_exact_redis_namespace_required");
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, code: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || !Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${code}:${String(resolved)}`);
  }
  return resolved;
}

export class RedisExactCache implements PersistentContextCache {
  private readonly members: ContextRedisMember[];
  private readonly namespace: string;
  private readonly failureMode: "open" | "closed";
  private readonly memberOperationTimeoutMs: number;
  private readonly memberFailureCooldownMs: number;
  private readonly memberUnavailableUntil = new Map<string, number>();

  constructor(options: RedisExactCacheOptions) {
    if (!Array.isArray(options.members) || options.members.length === 0) {
      throw new Error("context_exact_redis_members_required");
    }
    this.members = options.members;
    this.namespace = normalizeNamespace(options.namespace);
    this.failureMode = options.failureMode ?? "open";
    this.memberOperationTimeoutMs = positiveInteger(
      options.memberOperationTimeoutMs,
      1_500,
      "context_exact_redis_member_timeout_invalid",
    );
    this.memberFailureCooldownMs = positiveInteger(
      options.memberFailureCooldownMs,
      30_000,
      "context_exact_redis_failure_cooldown_invalid",
    );
  }

  private memberCircuitOpen(member: ContextRedisMember): boolean {
    if (member.availability) return member.availability.isUnavailable();
    const until = this.memberUnavailableUntil.get(member.label) ?? 0;
    if (until <= Date.now()) {
      if (until > 0) this.memberUnavailableUntil.delete(member.label);
      return false;
    }
    return true;
  }

  private markMemberUnavailable(member: ContextRedisMember): void {
    if (member.availability) {
      member.availability.markUnavailable(this.memberFailureCooldownMs);
      return;
    }
    this.memberUnavailableUntil.set(member.label, Date.now() + this.memberFailureCooldownMs);
  }

  private markMemberHealthy(member: ContextRedisMember): void {
    if (member.availability) {
      member.availability.markHealthy();
      return;
    }
    this.memberUnavailableUntil.delete(member.label);
  }

  private async command(
    member: ContextRedisMember,
    parts: Array<string | Buffer>,
  ): Promise<RedisReply> {
    if (this.memberCircuitOpen(member)) {
      throw new Error(`context_exact_redis_member_circuit_open:${member.label}`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = member.client.command(parts);
    // If the local deadline wins the race, the underlying shared RESP client
    // may still reject later. Attach a handler now so it never becomes an
    // unhandled rejection while the circuit is already open.
    operation.catch(() => undefined);
    try {
      const result = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(
              `context_exact_redis_member_timeout:${member.label}:${this.memberOperationTimeoutMs}:${String(parts[0] ?? "unknown")}`,
            )),
            this.memberOperationTimeoutMs,
          );
        }),
      ]);
      this.markMemberHealthy(member);
      return result;
    } catch (error) {
      this.markMemberUnavailable(member);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private activeMembers(): ContextRedisMember[] {
    return this.members.filter((member) => !this.memberCircuitOpen(member));
  }

  private entryKey(key: string): string {
    return `${this.namespace}:entry:${key}`;
  }

  private depKey(hash: string): string {
    return `${this.namespace}:dep:${hash}`;
  }

  private hashRegistryKey(): string {
    return `${this.namespace}:hash-registry`;
  }

  private fileHashRegistryKey(): string {
    return `${this.namespace}:file-hash-registry`;
  }

  private unavailable(operation: string): ContextCacheDependencyUnavailableError {
    return new ContextCacheDependencyUnavailableError(`context_exact_redis_unavailable:${operation}`);
  }

  private async readMember(member: ContextRedisMember, key: string): Promise<{
    raw: string | null;
    entry?: StoredExactEntry;
    stale: boolean;
  }> {
    const raw = asText(await this.command(member, ["GET", this.entryKey(key)])) ?? null;
    if (raw === null) return { raw: null, stale: false };
    let entry: StoredExactEntry;
    try {
      entry = JSON.parse(raw) as StoredExactEntry;
    } catch {
      return { raw, stale: true };
    }
    if (entry.version !== 1 || !Array.isArray(entry.deps)) return { raw, stale: true };
    if (entry.ttlMs > 0 && Date.now() >= entry.createdAt + entry.ttlMs) return { raw, entry, stale: true };
    for (const dep of entry.deps) {
      const current = asText(await this.command(member, ["HGET", this.hashRegistryKey(), dep]));
      if (current !== undefined && current !== dep) return { raw, entry, stale: true };
    }
    return { raw, entry, stale: false };
  }

  async get(key: string): Promise<L2GetResult | undefined> {
    // Once any exact member has opened its local circuit, exact L2 cannot
    // establish replica consensus. Return a conservative MISS immediately;
    // fresh authoritative retrieval remains available while the semantic
    // Redis layer can still use its surviving member after revalidation.
    const active = this.activeMembers();
    if (active.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("get");
      return undefined;
    }
    if (active.length !== this.members.length) return undefined;

    const settled = await Promise.allSettled(active.map((member) => this.readMember(member, key)));
    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<RedisExactCache["readMember"]>>> => result.status === "fulfilled");
    if (fulfilled.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("get");
      return undefined;
    }
    // Exact cache is stricter than semantic reuse. If any configured replica is
    // unreachable, treat L2 as a conservative MISS instead of letting one
    // potentially stale replica authorize an exact HIT.
    if (fulfilled.length !== this.members.length) return undefined;
    const values = fulfilled.map((result) => result.value);
    const staleCount = values.filter((value) => value.stale).length;
    if (staleCount > 0) {
      await this.delete(key).catch(() => undefined);
      // When every replica independently proves the same entry stale, retain
      // the legacy stale signal so TieredContextCache can account for it.
      // A mixed fresh/stale result means the replicas disagree after a
      // partial outage/recovery. That disagreement is not an authoritative
      // stale result: it is a conservative MISS. Returning `undefined` here
      // prevents a recovered stale replica from authorizing an exact HIT and
      // avoids pretending that all members observed the same freshness state.
      if (staleCount === values.length) {
        return { value: undefined, deps: [], stale: true };
      }
      return undefined;
    }
    const raws = values.map((value) => value.raw);
    if (raws.every((value) => value === null)) return undefined;
    if (raws.some((value) => value === null) || new Set(raws).size !== 1) {
      await this.delete(key).catch(() => undefined);
      return undefined;
    }
    const entry = values[0]?.entry;
    if (!entry) return undefined;
    return { value: entry.value, deps: [...entry.deps], stale: false };
  }

  async checkFresh(key: string): Promise<boolean> {
    const result = await this.get(key);
    return Boolean(result && !result.stale);
  }

  async set(key: string, value: unknown, deps: string[], ttlMs = 0): Promise<void> {
    const normalizedTtl = Math.max(0, Math.trunc(ttlMs));
    const stored: StoredExactEntry = {
      version: 1,
      value,
      deps: [...new Set(deps)],
      createdAt: Date.now(),
      ttlMs: normalizedTtl,
    };
    const raw = JSON.stringify(stored);
    const entryKey = this.entryKey(key);
    const active = this.activeMembers();
    if (active.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("set");
      return;
    }
    const writes = active.map(async (member) => {
      const set = ["SET", entryKey, raw];
      if (normalizedTtl > 0) set.push("PX", String(normalizedTtl));
      await this.command(member, set);
      for (const dep of stored.deps) {
        await this.command(member, ["HSETNX", this.hashRegistryKey(), dep, dep]);
        await this.command(member, ["SADD", this.depKey(dep), entryKey]);
      }
    });
    const settled = await Promise.allSettled(writes);
    if (!settled.some((result) => result.status === "fulfilled") && this.failureMode === "closed") {
      throw this.unavailable("set");
    }
  }

  async delete(key: string): Promise<boolean> {
    const entryKey = this.entryKey(key);
    const active = this.activeMembers();
    if (active.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("delete");
      return false;
    }
    const settled = await Promise.allSettled(active.map(async (member) => {
      const raw = asText(await this.command(member, ["GET", entryKey]));
      if (raw) {
        try {
          const entry = JSON.parse(raw) as StoredExactEntry;
          for (const dep of entry.deps ?? []) await this.command(member, ["SREM", this.depKey(dep), entryKey]);
        } catch {
          // Deleting a malformed cache entry is sufficient.
        }
      }
      return asInteger(await this.command(member, ["DEL", entryKey])) > 0;
    }));
    const successful = settled.filter((result): result is PromiseFulfilledResult<boolean> => result.status === "fulfilled");
    if (successful.length === 0 && this.failureMode === "closed") throw this.unavailable("delete");
    return successful.some((result) => result.value);
  }

  async invalidate(fileHash: string): Promise<number> {
    const active = this.activeMembers();
    if (active.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("invalidate");
      return 0;
    }
    const settled = await Promise.allSettled(active.map(async (member) => {
      const depKey = this.depKey(fileHash);
      const keys = asStringArray(await this.command(member, ["SMEMBERS", depKey]));
      let removed = 0;
      for (const key of keys) removed += asInteger(await this.command(member, ["DEL", key]));
      await this.command(member, ["DEL", depKey]);
      return removed;
    }));
    const successful = settled.filter((result): result is PromiseFulfilledResult<number> => result.status === "fulfilled");
    if (successful.length === 0 && this.failureMode === "closed") throw this.unavailable("invalidate");
    return Math.max(0, ...successful.map((result) => result.value));
  }

  async updateHash(oldHash: string, newHash: string): Promise<void> {
    const active = this.activeMembers();
    if (active.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("update-hash");
      return;
    }
    const settled = await Promise.allSettled(active.map((member) =>
      this.command(member, ["HSET", this.hashRegistryKey(), oldHash, newHash])));
    if (!settled.some((result) => result.status === "fulfilled") && this.failureMode === "closed") {
      throw this.unavailable("update-hash");
    }
  }

  async recordFileHash(filePath: string, currentHash: string): Promise<void> {
    const active = this.activeMembers();
    if (active.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("record-file-hash");
      return;
    }
    const settled = await Promise.allSettled(active.map((member) =>
      this.command(member, ["HSET", this.fileHashRegistryKey(), filePath, currentHash])));
    if (!settled.some((result) => result.status === "fulfilled") && this.failureMode === "closed") {
      throw this.unavailable("record-file-hash");
    }
  }

  async getFileHash(filePath: string): Promise<string | undefined> {
    const active = this.activeMembers();
    if (active.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("get-file-hash");
      return undefined;
    }
    if (active.length !== this.members.length) return undefined;
    const settled = await Promise.allSettled(active.map((member) =>
      this.command(member, ["HGET", this.fileHashRegistryKey(), filePath])));
    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<RedisReply> => result.status === "fulfilled");
    if (fulfilled.length === 0) {
      if (this.failureMode === "closed") throw this.unavailable("get-file-hash");
      return undefined;
    }
    if (fulfilled.length !== this.members.length) return undefined;
    const values = fulfilled.map((result) => asText(result.value));
    const nonEmpty = values.filter((value): value is string => value !== undefined);
    if (nonEmpty.length === 0) return undefined;
    return new Set(values).size === 1 ? values[0] : undefined;
  }
}
