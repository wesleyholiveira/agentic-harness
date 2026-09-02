import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stableStringify, type CacheTier, type TieredContextCache } from "@agent-harness/context-cache";
import { estimateTokens } from "./budget-optimizer";
import type {
  ContextPack,
  ContextReference,
  FileDependency,
  StoredContextReference,
} from "./types";

const DEFAULT_REFERENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function packIdentity(pack: ContextPack): unknown {
  return {
    task_analysis: pack.task_analysis,
    previous_decisions: pack.previous_decisions,
    symbols: pack.symbols,
    architecture: pack.architecture,
    static_artifacts: pack.static_artifacts,
    summaries: pack.summaries,
    dependencies: pack.dependencies,
    external_docs: pack.external_docs,
    source_revisions: pack.metadata.source_revisions ?? {},
    warnings: pack.metadata.warnings,
  };
}

export interface ContextReferenceLookup {
  value: StoredContextReference;
  tier: CacheTier;
}

export class ContextReferenceStore {
  constructor(
    private cache: TieredContextCache,
    private ttlMs = DEFAULT_REFERENCE_TTL_MS,
    private cwd = process.cwd(),
  ) {}

  async put(source: string, content: unknown, fileDependencies: FileDependency[] = []): Promise<ContextReference> {
    const hash = digest(content);
    const ref = `ctxref:${hash}`;
    const stored: StoredContextReference = {
      ref,
      source,
      content,
      created_at: new Date().toISOString(),
      ...(fileDependencies.length > 0 ? { file_dependencies: fileDependencies } : {}),
    };
    await this.recordDependencies(fileDependencies);
    await this.cache.set(
      this.key(ref),
      stored,
      fileDependencies.map((dependency) => dependency.hash),
      this.ttlMs,
    );
    return this.describe(ref, source, content);
  }

  async putPack(pack: ContextPack, fileDependencies = this.capturePackDependencies(pack)): Promise<string> {
    const hash = digest(packIdentity(pack));
    const ref = `ctxpack:${hash}`;
    const stored: StoredContextReference = {
      ref,
      source: "context-pack",
      content: pack,
      created_at: new Date().toISOString(),
      ...(fileDependencies.length > 0 ? { file_dependencies: fileDependencies } : {}),
    };
    await this.recordDependencies(fileDependencies);
    await this.cache.set(
      this.key(ref),
      stored,
      fileDependencies.map((dependency) => dependency.hash),
      this.ttlMs,
    );
    return ref;
  }

  async resolve(ref: string): Promise<StoredContextReference | undefined> {
    return (await this.resolveWithMeta(ref))?.value;
  }

  async resolveWithMeta(ref: string): Promise<ContextReferenceLookup | undefined> {
    if (!ref.startsWith("ctxref:") && !ref.startsWith("ctxpack:")) return undefined;
    const hit = await this.cache.get<StoredContextReference>(this.key(ref));
    if (!hit) return undefined;
    if (!this.dependenciesFresh(hit.value.file_dependencies ?? [])) {
      await this.cache.delete(this.key(ref));
      return undefined;
    }
    return { value: hit.value, tier: hit.tier };
  }

  private key(ref: string): string {
    return `context-reference:v1:${ref}`;
  }

  private describe(ref: string, source: string, content: unknown): ContextReference {
    const reference: ContextReference = {
      ref,
      source,
      token_cost: estimateTokens(content),
    };
    if (Array.isArray(content)) reference.item_count = content.length;
    const preview = this.preview(content);
    if (preview) reference.preview = preview;
    return reference;
  }

  private preview(content: unknown): string | undefined {
    if (typeof content === "string") {
      return content.replace(/\s+/g, " ").trim().slice(0, 180) || undefined;
    }
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0];
      if (first && typeof first === "object") {
        const record = first as Record<string, unknown>;
        const label = record.qualified_name ?? record.title ?? record.library ?? record.path;
        if (typeof label === "string") return label.slice(0, 180);
      }
    }
    return undefined;
  }

  private capturePackDependencies(pack: ContextPack): FileDependency[] {
    const exact = pack.static_artifacts.map((artifact) => ({
      path: artifact.path,
      hash: artifact.content_hash,
    }));
    const discoveredPaths = [
      ...pack.symbols.flatMap((value) => this.pathsFromField(value, "file")),
      ...pack.previous_decisions.flatMap((value) => this.pathsFromField(value, "files")),
    ];
    const captured = this.captureDependencies(discoveredPaths);
    const merged = new Map<string, FileDependency>();
    for (const dependency of [...captured, ...exact]) merged.set(dependency.path, dependency);
    return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private pathsFromField(value: unknown, field: string): string[] {
    if (!value || typeof value !== "object" || !(field in value)) return [];
    const found = (value as Record<string, unknown>)[field];
    if (typeof found === "string") return [found];
    if (Array.isArray(found)) return found.filter((path): path is string => typeof path === "string");
    return [];
  }

  private captureDependencies(paths: string[]): FileDependency[] {
    const dependencies = new Map<string, FileDependency>();
    for (const path of paths) {
      const absolute = resolve(this.cwd, path);
      if (!existsSync(absolute)) continue;
      try {
        const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        dependencies.set(path, { path, hash });
      } catch {
        // A file can disappear between discovery and hashing.
      }
    }
    return [...dependencies.values()];
  }

  private async recordDependencies(dependencies: FileDependency[]): Promise<void> {
    for (const dependency of dependencies) {
      await this.cache.recordFileHash(dependency.path, dependency.hash);
    }
  }

  private dependenciesFresh(dependencies: FileDependency[]): boolean {
    for (const dependency of dependencies) {
      const absolute = resolve(this.cwd, dependency.path);
      if (!existsSync(absolute)) return false;
      try {
        const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        if (hash !== dependency.hash) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
}
