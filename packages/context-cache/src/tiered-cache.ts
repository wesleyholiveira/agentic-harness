import type { CacheLookup, PersistentContextCache, TieredCacheStats } from "./types";
import type { L1SessionCache } from "./l1-session";

export class TieredContextCache {
  private l1Hits = 0;
  private l2Hits = 0;
  private misses = 0;
  private stale = 0;
  private writes = 0;
  private invalidations = 0;

  constructor(
    private l1: L1SessionCache,
    private l2: PersistentContextCache,
  ) {}

  async get<T>(key: string): Promise<CacheLookup<T> | undefined> {
    const l1Value = this.l1.get(key);
    if (l1Value !== undefined) {
      this.l1Hits++;
      return { value: l1Value as T, tier: "l1" };
    }

    const l2Result = await this.l2.get(key);
    if (!l2Result) {
      this.misses++;
      return undefined;
    }
    if (l2Result.stale) {
      this.stale++;
      await this.delete(key);
      this.misses++;
      return undefined;
    }

    this.l2Hits++;
    this.l1.set(key, l2Result.value, l2Result.deps);
    return { value: l2Result.value as T, tier: "l2" };
  }

  async set(key: string, value: unknown, deps: string[] = [], ttlMs?: number): Promise<void> {
    // Persist first. In fail-closed mode a total Redis outage must not leave a
    // newly produced value behind in L1 after the authoritative request failed.
    await this.l2.set(key, value, deps, ttlMs ?? 0);
    this.l1.set(key, value, deps, ttlMs);
    this.writes++;
  }

  async delete(key: string): Promise<void> {
    const l1Removed = this.l1.delete(key);
    const l2Removed = await this.l2.delete(key);
    this.invalidations += Number(l1Removed) + Number(l2Removed);
  }

  async invalidate(fileHash: string): Promise<number> {
    const removed = this.l1.invalidate(fileHash) + await this.l2.invalidate(fileHash);
    this.invalidations += removed;
    return removed;
  }

  async updateHash(oldHash: string, newHash: string): Promise<void> {
    await this.l2.updateHash(oldHash, newHash);
  }

  async recordFileHash(filePath: string, currentHash: string): Promise<void> {
    await this.l2.recordFileHash(filePath, currentHash);
  }

  async getFileHash(filePath: string): Promise<string | undefined> {
    return await this.l2.getFileHash(filePath);
  }

  getStats(): TieredCacheStats {
    const lookups = this.l1Hits + this.l2Hits + this.misses;
    const hits = this.l1Hits + this.l2Hits;
    return {
      l1_hits: this.l1Hits,
      l2_hits: this.l2Hits,
      misses: this.misses,
      stale: this.stale,
      writes: this.writes,
      invalidations: this.invalidations,
      hit_rate: lookups === 0 ? 0 : hits / lookups,
    };
  }

  async close(): Promise<void> {
    await this.l2.close?.();
  }
}
