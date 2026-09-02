import type {
  SemanticCacheScope,
  SemanticSourceRevisions,
  SemanticTaskDescriptor,
} from "@agent-harness/context-semantic-cache";
import type { ContextPack, TaskAnalysis } from "./types";

export interface ContextPackBuildContext {
  semanticScope?: Partial<SemanticCacheScope>;
}

export function toSemanticTaskDescriptor(task: string, analysis: TaskAnalysis): SemanticTaskDescriptor {
  return {
    text: task,
    fingerprint: analysis.signature.fingerprint,
    intent: analysis.signature.intent,
    canonicalQuery: analysis.signature.canonical_query,
    domains: [...analysis.signature.domains],
    files: [...analysis.signature.files],
    symbols: [...analysis.signature.symbols],
    language: analysis.detected_language,
  };
}

export function toSemanticSourceRevisions(revisions: {
  memory: string;
  cbm: string;
  artifacts: string;
}): SemanticSourceRevisions {
  return { ...revisions };
}

function pathsFromField(value: unknown, field: string): string[] {
  if (!value || typeof value !== "object" || !(field in value)) return [];
  const found = (value as Record<string, unknown>)[field];
  if (typeof found === "string") return [found];
  if (Array.isArray(found)) return found.filter((path): path is string => typeof path === "string");
  return [];
}

export function semanticRelevantPaths(pack: ContextPack): string[] {
  const paths = [
    ...pack.task_analysis.signature.files,
    ...pack.symbols.flatMap((value) => pathsFromField(value, "file")),
    ...pack.previous_decisions.flatMap((value) => pathsFromField(value, "files")),
    ...pack.static_artifacts.map((artifact) => artifact.path),
  ]
    .map((value) => value.replaceAll("\\", "/").replace(/^\.\/+/, "").trim())
    .filter(Boolean);
  return [...new Set(paths)].sort();
}
