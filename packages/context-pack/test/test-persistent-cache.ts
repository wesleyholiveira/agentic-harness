import type { L2GetResult, PersistentContextCache } from "@agent-harness/context-cache";

interface Stored {
  value: unknown;
  deps: string[];
  createdAt: number;
  ttlMs: number;
}

export class TestPersistentCache implements PersistentContextCache {
  private readonly entries = new Map<string, Stored>();
  private readonly hashRegistry = new Map<string, string>();
  private readonly fileHashes = new Map<string, string>();

  async get(key: string): Promise<L2GetResult | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.ttlMs > 0 && Date.now() >= entry.createdAt + entry.ttlMs) {
      this.entries.delete(key);
      return { value: undefined, deps: [...entry.deps], stale: true };
    }
    for (const dep of entry.deps) {
      const current = this.hashRegistry.get(dep);
      if (current !== undefined && current !== dep) {
        this.entries.delete(key);
        return { value: undefined, deps: [...entry.deps], stale: true };
      }
    }
    return { value: entry.value, deps: [...entry.deps], stale: false };
  }

  async checkFresh(key: string): Promise<boolean> {
    const result = await this.get(key);
    return Boolean(result && !result.stale);
  }

  async set(key: string, value: unknown, deps: string[], ttlMs = 0): Promise<void> {
    const uniqueDeps = [...new Set(deps)];
    this.entries.set(key, { value, deps: uniqueDeps, createdAt: Date.now(), ttlMs: Math.max(0, ttlMs) });
    for (const dep of uniqueDeps) if (!this.hashRegistry.has(dep)) this.hashRegistry.set(dep, dep);
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async invalidate(fileHash: string): Promise<number> {
    let removed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.deps.includes(fileHash)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async updateHash(oldHash: string, newHash: string): Promise<void> {
    this.hashRegistry.set(oldHash, newHash);
  }

  async recordFileHash(path: string, currentHash: string): Promise<void> {
    this.fileHashes.set(path, currentHash);
  }

  async getFileHash(path: string): Promise<string | undefined> {
    return this.fileHashes.get(path);
  }
}
