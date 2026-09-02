import { stableStringify } from "@agent-harness/context-cache";
import type { ContextPack, ContextPackItem } from "./types";

export function estimateTokens(content: unknown): number {
  const serialized = typeof content === "string" ? content : JSON.stringify(content);
  const str = serialized ?? "";
  return Math.ceil(str.length / 4);
}

export function rankByUtility(items: ContextPackItem[]): ContextPackItem[] {
  return [...items].sort((a, b) => utility(b) - utility(a));
}

type Section =
  | "previous_decisions"
  | "symbols"
  | "architecture"
  | "static_artifacts"
  | "summaries"
  | "callers"
  | "callees"
  | "tests"
  | "external_docs";

interface Candidate extends ContextPackItem {
  section: Section;
  diversity_key: string;
  ordinal: number;
}

function utility(item: ContextPackItem): number {
  return (item.relevance_score * item.freshness) / Math.max(item.token_cost, 1);
}

function freshnessFromTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const ageDays = Math.max(0, Date.now() - value) / 86_400_000;
  return Math.max(0.25, 1 / (1 + ageDays / 90));
}

function objectField(value: unknown, field: string): unknown {
  if (value && typeof value === "object" && field in value) {
    return (value as Record<string, unknown>)[field];
  }
  return undefined;
}

function diversityKey(section: Section, content: unknown): string {
  const qualifiedName = objectField(content, "qualified_name");
  if (typeof qualifiedName === "string") return `${section}:symbol:${qualifiedName}`;
  const id = objectField(content, "id");
  if (typeof id === "string") return `${section}:id:${id}`;
  const file = objectField(content, "file");
  if (typeof file === "string") return `${section}:file:${file}:${stableStringify(content)}`;
  const path = objectField(content, "path");
  if (typeof path === "string") return `${section}:path:${path}`;
  return `${section}:${stableStringify(content)}`;
}

function candidatesFromArray(section: Section, values: unknown[], baseRelevance: number): Candidate[] {
  return values.map((content, ordinal) => {
    const createdAt = objectField(content, "created_at");
    const inDegree = objectField(content, "in_degree");
    const outDegree = objectField(content, "out_degree");
    const degreeBonus =
      (typeof inDegree === "number" ? Math.min(inDegree, 20) * 0.005 : 0) +
      (typeof outDegree === "number" ? Math.min(outDegree, 20) * 0.003 : 0);
    return {
      source: section,
      section,
      relevance_score: Math.max(0.05, Math.min(1, baseRelevance - ordinal * 0.015 + degreeBonus)),
      freshness: freshnessFromTimestamp(createdAt),
      token_cost: estimateTokens(content),
      content,
      diversity_key: diversityKey(section, content),
      ordinal,
    };
  });
}

function collectCandidates(pack: ContextPack): Candidate[] {
  const staticArtifacts = pack.static_artifacts.map((artifact, ordinal) => ({
    source: "static_artifacts",
    section: "static_artifacts" as const,
    relevance_score: Math.max(0.05, Math.min(1, artifact.relevance_score)),
    freshness: 1,
    token_cost: estimateTokens(artifact),
    content: artifact,
    diversity_key: diversityKey("static_artifacts", artifact),
    ordinal,
  }));
  const candidates: Candidate[] = [
    ...candidatesFromArray("symbols", pack.symbols, 1),
    ...candidatesFromArray("previous_decisions", pack.previous_decisions, 0.96),
    ...staticArtifacts,
    ...candidatesFromArray("callers", pack.dependencies.callers, 0.92),
    ...candidatesFromArray("callees", pack.dependencies.callees, 0.9),
    ...candidatesFromArray("tests", pack.dependencies.tests, 0.9),
    ...candidatesFromArray("summaries", pack.summaries, 0.82),
    ...candidatesFromArray("external_docs", pack.external_docs, 0.72),
  ];
  if (pack.architecture) {
    candidates.push({
      source: "architecture",
      section: "architecture",
      relevance_score: 0.7,
      freshness: 1,
      token_cost: estimateTokens(pack.architecture),
      content: pack.architecture,
      diversity_key: "architecture",
      ordinal: 0,
    });
  }
  return candidates;
}

function emptyPayload(pack: ContextPack): ContextPack {
  return {
    ...pack,
    previous_decisions: [],
    symbols: [],
    architecture: "",
    static_artifacts: [],
    summaries: [],
    dependencies: { callers: [], callees: [], tests: [] },
    external_docs: [],
    metadata: { ...pack.metadata, warnings: [...pack.metadata.warnings] },
  };
}

function appendCandidate(pack: ContextPack, candidate: Candidate): ContextPack {
  switch (candidate.section) {
    case "previous_decisions":
      return { ...pack, previous_decisions: [...pack.previous_decisions, candidate.content] };
    case "symbols":
      return { ...pack, symbols: [...pack.symbols, candidate.content] };
    case "architecture":
      return { ...pack, architecture: String(candidate.content) };
    case "static_artifacts":
      return {
        ...pack,
        static_artifacts: [...pack.static_artifacts, candidate.content as ContextPack["static_artifacts"][number]],
      };
    case "summaries":
      return { ...pack, summaries: [...pack.summaries, candidate.content] };
    case "callers":
      return {
        ...pack,
        dependencies: { ...pack.dependencies, callers: [...pack.dependencies.callers, candidate.content] },
      };
    case "callees":
      return {
        ...pack,
        dependencies: { ...pack.dependencies, callees: [...pack.dependencies.callees, candidate.content] },
      };
    case "tests":
      return {
        ...pack,
        dependencies: { ...pack.dependencies, tests: [...pack.dependencies.tests, candidate.content] },
      };
    case "external_docs":
      return { ...pack, external_docs: [...pack.external_docs, candidate.content] };
  }
}

function warningForSection(section: Section): string {
  if (section === "architecture") return "architecture_removed_by_budget_optimizer";
  if (section === "static_artifacts") return "static_artifacts_truncated_by_budget_optimizer";
  if (section === "external_docs") return "external_docs_truncated_by_budget_optimizer";
  if (section === "summaries") return "summaries_truncated_by_budget_optimizer";
  if (section === "symbols") return "symbols_truncated_by_budget_optimizer";
  if (section === "previous_decisions") return "decisions_truncated_by_budget_optimizer";
  return `dependencies_${section}_truncated_by_budget_optimizer`;
}

function deduplicate(pack: ContextPack): { pack: ContextPack; candidates: Candidate[]; duplicateCount: number } {
  const allCandidates = collectCandidates(pack);
  const seen = new Set<string>();
  const uniqueCandidates: Candidate[] = [];
  let deduplicated = emptyPayload(pack);

  for (const candidate of allCandidates) {
    if (seen.has(candidate.diversity_key)) continue;
    seen.add(candidate.diversity_key);
    uniqueCandidates.push(candidate);
    deduplicated = appendCandidate(deduplicated, candidate);
  }

  return {
    pack: deduplicated,
    candidates: uniqueCandidates,
    duplicateCount: allCandidates.length - uniqueCandidates.length,
  };
}

function withFinalMetadata(pack: ContextPack, budget: number, warnings: string[]): ContextPack {
  const withMetadata: ContextPack = {
    ...pack,
    metadata: {
      ...pack.metadata,
      budget,
      warnings,
      total_tokens: 0,
    },
  };
  withMetadata.metadata.total_tokens = estimateTokens(withMetadata);
  return withMetadata;
}

export function optimize(pack: ContextPack, budget: number): ContextPack {
  const initialTokens = estimateTokens(pack);
  const { pack: deduplicated, candidates, duplicateCount } = deduplicate(pack);

  if (initialTokens <= budget && duplicateCount === 0) return pack;

  const baseWarnings = [...pack.metadata.warnings];
  if (duplicateCount > 0 && !baseWarnings.includes("duplicate_items_removed_by_budget_optimizer")) {
    baseWarnings.push("duplicate_items_removed_by_budget_optimizer");
  }

  const deduplicatedWithMetadata = withFinalMetadata(deduplicated, budget, baseWarnings);
  if (estimateTokens(deduplicatedWithMetadata) <= budget) return deduplicatedWithMetadata;

  let optimized = emptyPayload(pack);
  const omittedSections = new Set<Section>();
  const includedSourceCounts = new Map<string, number>();
  const remaining = [...candidates];

  // Re-rank after every accepted item. Repeated items from the same source receive a
  // small penalty, which preserves utility ordering while preventing one verbose
  // source from monopolising a tight budget.
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index];
      if (!candidate) continue;
      const selectedFromSource = includedSourceCounts.get(candidate.source) ?? 0;
      const score = utility(candidate) / (1 + selectedFromSource * 0.12);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    const [candidate] = remaining.splice(bestIndex, 1);
    if (!candidate) break;
    const next = appendCandidate(optimized, candidate);
    const probeWarnings = [...baseWarnings];
    const nextWithMetadata = withFinalMetadata(next, budget, probeWarnings);
    if (estimateTokens(nextWithMetadata) <= budget) {
      optimized = next;
      includedSourceCounts.set(candidate.source, (includedSourceCounts.get(candidate.source) ?? 0) + 1);
    } else {
      omittedSections.add(candidate.section);
    }
  }

  const warnings = [...baseWarnings];
  for (const section of omittedSections) {
    const warning = warningForSection(section);
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  if (estimateTokens(emptyPayload(pack)) > budget && !warnings.includes("budget_floor_exceeded_by_required_metadata")) {
    warnings.push("budget_floor_exceeded_by_required_metadata");
  }

  return withFinalMetadata(optimized, budget, warnings);
}
