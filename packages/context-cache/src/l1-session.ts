interface L1Entry {
  value: unknown;
  deps: string[];
  expiresAt: number;
}

export class L1SessionCache {
  private store = new Map<string, L1Entry>();

  constructor(private defaultTtlMs: number) {}

  set(key: string, value: unknown, deps: string[], ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.store.set(key, { value, deps, expiresAt });
  }

  get(key: string): unknown {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  invalidate(fileHash: string): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.deps.includes(fileHash)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
  }
}
