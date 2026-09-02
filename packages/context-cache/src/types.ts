export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  deps: string[];
  created_at: number;
  ttl_ms: number;
}

export interface CacheDeps {
  fileHashes: Record<string, string>;
}

export interface CacheCheckResult {
  hit: boolean;
  stale: boolean;
  value?: unknown;
}

export interface L2GetResult {
  value: unknown;
  deps: string[];
  stale: boolean;
}

export interface PersistentContextCache {
  get(key: string): Promise<L2GetResult | undefined>;
  checkFresh(key: string): Promise<boolean>;
  set(key: string, value: unknown, deps: string[], ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  invalidate(fileHash: string): Promise<number>;
  updateHash(oldHash: string, newHash: string): Promise<void>;
  recordFileHash(filePath: string, currentHash: string): Promise<void>;
  getFileHash(filePath: string): Promise<string | undefined>;
  close?(): Promise<void>;
}

export type CacheTier = "l1" | "l2";

export interface CacheLookup<T = unknown> {
  value: T;
  tier: CacheTier;
}

export interface TieredCacheStats {
  l1_hits: number;
  l2_hits: number;
  misses: number;
  stale: number;
  writes: number;
  invalidations: number;
  hit_rate: number;
}
