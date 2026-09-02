import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { createCacheKey, type CacheTier, type TieredContextCache } from "@agent-harness/context-cache";
import { estimateTokens } from "./budget-optimizer";
import type {
  StaticArtifact,
  StaticArtifactKind,
  StaticArtifactSearchResult,
  TaskAnalysis,
} from "./types";

interface CachedStaticArtifact {
  path: string;
  kind: StaticArtifactKind;
  title: string;
  content_hash: string;
  token_cost: number;
  content: string;
}

export interface StaticArtifactCacheOptions {
  cache?: TieredContextCache;
  cwd?: string;
  ttlMs?: number;
  candidateLimit?: number;
  resultLimit?: number;
  minRelativeScore?: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CANDIDATE_LIMIT = 24;
const DEFAULT_RESULT_LIMIT = 8;
const DEFAULT_MIN_RELATIVE_SCORE = 0.55;
const SUPPORTED_EXTENSIONS = new Set([".md", ".json", ".yaml", ".yml"]);

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function extension(path: string): string {
  const match = path.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

function classifyArtifact(path: string): StaticArtifactKind | undefined {
  const normalized = normalizePath(path);
  const lower = normalized.toLowerCase();
  const file = basename(lower);

  if (!SUPPORTED_EXTENSIONS.has(extension(lower))) return undefined;
  if (/^docs\/adr\/[^/]+\.md$/.test(lower)) return "adr";
  if (/(^|\/)prd\.md$/.test(lower)) return "prd";
  if (lower.startsWith("docs/evaluations/")) return "evaluation";
  if (/(^|\/)task-briefs\/[^/]+\.(?:json|md)$/.test(lower)) return "task-brief";
  if (/(^|\/)tech-brief\.md$/.test(lower)) return "tech-brief";
  if (lower.startsWith("docs/design/") && file.endsWith(".md")) return "design";
  if (
    lower.startsWith("docs/icr/") ||
    lower.startsWith("docs/icrs/") ||
    lower.startsWith("docs/incidents/") ||
    /(^|\/)icr[-_.]/.test(lower)
  ) {
    return "icr";
  }
  return undefined;
}

function kindPriority(kind: StaticArtifactKind): number {
  switch (kind) {
    case "adr":
      return 1;
    case "prd":
      return 0.98;
    case "icr":
      return 0.96;
    case "evaluation":
      return 0.9;
    case "tech-brief":
      return 0.86;
    case "design":
      return 0.82;
    case "task-brief":
      return 0.78;
  }
}

function kindTerms(kind: StaticArtifactKind): string[] {
  switch (kind) {
    case "adr":
      return ["adr", "adrs", "architecture", "decision"];
    case "prd":
      return ["prd", "prds", "product", "requirement", "requirements"];
    case "icr":
      return ["icr", "icrs", "incident", "change", "request"];
    case "evaluation":
      return ["evaluation", "evaluations", "benchmark", "readiness", "canary", "report"];
    case "tech-brief":
      return ["tech", "brief", "technical"];
    case "design":
      return ["design", "ux", "architecture"];
    case "task-brief":
      return ["task", "brief", "task-brief"];
  }
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function titleFromContent(path: string, content: string): string {
  if (path.toLowerCase().endsWith(".md")) {
    const heading = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^#\s+/.test(line));
    if (heading) return heading.replace(/^#\s+/, "").trim();
  }

  if (path.toLowerCase().endsWith(".json")) {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of ["title", "name", "summary", "task", "id"]) {
          const value = record[key];
          if (typeof value === "string" && value.trim()) return value.trim();
        }
      }
    } catch {
      // Keep the file name fallback for malformed/in-progress JSON documents.
    }
  }

  return basename(path);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ScoredPath {
  path: string;
  kind: StaticArtifactKind;
  score: number;
}

export class StaticArtifactCache {
  private cache: TieredContextCache | undefined;
  private cwd: string;
  private ttlMs: number;
  private candidateLimit: number;
  private resultLimit: number;
  private minRelativeScore: number;

  constructor(options: StaticArtifactCacheOptions = {}) {
    this.cache = options.cache;
    this.cwd = options.cwd ?? process.cwd();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    this.resultLimit = options.resultLimit ?? DEFAULT_RESULT_LIMIT;
    this.minRelativeScore = options.minRelativeScore ?? DEFAULT_MIN_RELATIVE_SCORE;
  }

  getCatalogRevision(): string {
    const paths = this.discoverPaths();
    return createCacheKey("static-artifact-catalog:v1", { paths });
  }

  getTaskRevision(taskAnalysis: TaskAnalysis): string {
    const paths = this.discoverPaths();
    const catalogRevision = createCacheKey("static-artifact-catalog:v1", { paths });
    const candidates = this.scorePaths(paths, taskAnalysis).slice(0, this.candidateLimit);
    const fileRevisions = candidates.map((candidate) => {
      try {
        const hash = sha256(readFileSync(resolve(this.cwd, candidate.path)));
        return { path: candidate.path, kind: candidate.kind, hash };
      } catch {
        return { path: candidate.path, kind: candidate.kind, hash: "unavailable" };
      }
    });
    return createCacheKey("static-artifact-task-revision:v1", {
      catalog_revision: catalogRevision,
      candidates: fileRevisions,
    });
  }

  discoverPaths(): string[] {
    const discovered: string[] = [];
    const visit = (absoluteDir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(absoluteDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const absolute = resolve(absoluteDir, entry.name);
        if (entry.isDirectory()) {
          visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const path = normalizePath(relative(this.cwd, absolute));
        if (classifyArtifact(path)) discovered.push(path);
      }
    };

    for (const root of [
      "docs/adr",
      "docs/specs",
      "docs/evaluations",
      "docs/design",
      "docs/product",
      "docs/icr",
      "docs/icrs",
      "docs/incidents",
    ]) {
      const absolute = resolve(this.cwd, root);
      if (existsSync(absolute)) visit(absolute);
    }
    return discovered.sort();
  }

  async search(taskAnalysis: TaskAnalysis, limit = this.resultLimit): Promise<StaticArtifactSearchResult> {
    const paths = this.discoverPaths();
    const catalogRevision = createCacheKey("static-artifact-catalog:v1", { paths });
    const scored = this.scorePaths(paths, taskAnalysis).slice(0, this.candidateLimit);
    const queryTokens = this.queryTokens(taskAnalysis);
    let cacheHits = 0;
    let cacheMisses = 0;
    const loaded: StaticArtifact[] = [];

    for (const candidate of scored) {
      const result = await this.load(candidate.path, candidate.score);
      if (!result) continue;
      if (result.cacheTier) cacheHits++;
      else cacheMisses++;

      const titleTokens = new Set(tokenize(result.artifact.title));
      const titleOverlap = [...queryTokens].filter((token) => titleTokens.has(token)).length;
      const contentPrefixTokens = new Set(tokenize(result.artifact.content.slice(0, 12_000)));
      const contentOverlap = [...queryTokens].filter((token) => contentPrefixTokens.has(token)).length;
      loaded.push({
        ...result.artifact,
        relevance_score: candidate.score + titleOverlap * 2.5 + Math.min(contentOverlap, 8) * 0.35,
      });
    }

    const maxScore = Math.max(1, ...loaded.map((artifact) => artifact.relevance_score));
    const normalized = loaded
      .map((artifact) => ({
        ...artifact,
        relevance_score: artifact.relevance_score / maxScore,
      }))
      .filter((artifact) => artifact.relevance_score >= this.minRelativeScore);
    const artifacts = this.selectDiverse(normalized, limit);
    return {
      artifacts,
      catalog_revision: catalogRevision,
      discovered_count: paths.length,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
    };
  }

  private async load(
    path: string,
    relevanceScore: number,
  ): Promise<{ artifact: StaticArtifact; cacheTier?: CacheTier } | undefined> {
    const absolute = resolve(this.cwd, path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      return undefined;
    }

    const contentHash = sha256(bytes);
    const kind = classifyArtifact(path);
    if (!kind) return undefined;
    const key = createCacheKey("static-artifact:v1", { path, kind, content_hash: contentHash });

    if (this.cache) {
      try {
        const hit = await this.cache.get<CachedStaticArtifact>(key);
        if (hit) {
          await this.cache.recordFileHash(path, contentHash);
          return {
            artifact: { ...hit.value, relevance_score: relevanceScore },
            cacheTier: hit.tier,
          };
        }
      } catch {
        // File-backed cache is reconstructible; fall through to parsing the current bytes.
      }
    }

    const content = bytes.toString("utf8");
    const cached: CachedStaticArtifact = {
      path,
      kind,
      title: titleFromContent(path, content),
      content_hash: contentHash,
      token_cost: estimateTokens(content),
      content,
    };

    if (this.cache) {
      try {
        await this.cache.recordFileHash(path, contentHash);
        await this.cache.set(key, cached, [contentHash], this.ttlMs);
      } catch {
        // Cache failures must never prevent deterministic filesystem retrieval.
      }
    }

    return { artifact: { ...cached, relevance_score: relevanceScore } };
  }

  private scorePaths(paths: string[], taskAnalysis: TaskAnalysis): ScoredPath[] {
    const queryTokens = this.queryTokens(taskAnalysis);
    const explicitFiles = new Set(taskAnalysis.signature.files.map(normalizePath));
    const scored: ScoredPath[] = [];

    for (const path of paths) {
      const kind = classifyArtifact(path);
      if (!kind) continue;
      const pathTokens = new Set(tokenize(path));
      const overlap = [...queryTokens].filter((token) => pathTokens.has(token)).length;
      const kindMentioned = kindTerms(kind).some((term) => queryTokens.has(term));
      const explicit = explicitFiles.has(path) || [...explicitFiles].some((file) => path.endsWith(`/${file}`));
      const numericMatches = [...queryTokens].filter(
        (token) => /^\d{2,}$/.test(token) && pathTokens.has(token),
      ).length;

      if (!explicit && overlap === 0 && !kindMentioned && numericMatches === 0) continue;

      let score = kindPriority(kind) + overlap * 4 + numericMatches * 8;
      if (kindMentioned) score += 3;
      if (explicit) score += 100;
      scored.push({ path, kind, score });
    }

    return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }

  private queryTokens(taskAnalysis: TaskAnalysis): Set<string> {
    const domainTokens = taskAnalysis.signature.domains.flatMap((domain) => tokenize(domain));
    const fileTokens = taskAnalysis.signature.files.flatMap((file) => tokenize(file));
    const symbolTokens = taskAnalysis.signature.symbols.flatMap((symbol) => tokenize(symbol));
    return new Set(unique([...taskAnalysis.concepts, ...domainTokens, ...fileTokens, ...symbolTokens]));
  }

  private selectDiverse(artifacts: StaticArtifact[], limit: number): StaticArtifact[] {
    const remaining = [...artifacts].sort(
      (a, b) => b.relevance_score - a.relevance_score || a.path.localeCompare(b.path),
    );
    const selected: StaticArtifact[] = [];
    const kindCounts = new Map<StaticArtifactKind, number>();
    const specCounts = new Map<string, number>();

    while (remaining.length > 0 && selected.length < limit) {
      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let index = 0; index < remaining.length; index++) {
        const artifact = remaining[index];
        if (!artifact) continue;
        const kindCount = kindCounts.get(artifact.kind) ?? 0;
        const specKey = this.specScope(artifact.path);
        const specCount = specKey ? (specCounts.get(specKey) ?? 0) : 0;
        const score = artifact.relevance_score / (1 + kindCount * 0.18 + specCount * 0.12);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }

      const [artifact] = remaining.splice(bestIndex, 1);
      if (!artifact) break;
      selected.push(artifact);
      kindCounts.set(artifact.kind, (kindCounts.get(artifact.kind) ?? 0) + 1);
      const specKey = this.specScope(artifact.path);
      if (specKey) specCounts.set(specKey, (specCounts.get(specKey) ?? 0) + 1);
    }

    return selected;
  }

  private specScope(path: string): string | undefined {
    const match = normalizePath(path).match(/^docs\/specs\/([^/]+)\//);
    return match?.[1];
  }
}
