import { createCacheKey } from "@agent-harness/context-cache";
import type { TaskAnalysis, TaskSignature } from "./types";

const EXTERNAL_LIB_KEYWORDS = [
  "redis",
  "nextauth",
  "oauth",
  "stripe",
  "prisma",
  "express",
  "fastapi",
  "django",
  "spring",
  "graphql",
  "mongodb",
  "postgres",
  "postgresql",
  "sqlite",
  "docker",
  "kubernetes",
  "headroom",
];

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "when",
  "while",
  "where",
  "should",
  "would",
  "could",
  "mais",
  "menos",
  "para",
  "com",
  "sem",
  "que",
  "uma",
  "um",
  "das",
  "dos",
  "deixar",
  "forma",
  "sobre",
  "isso",
  "esta",
  "este",
  "tambem",
  "ainda",
  "muito",
  "como",
  "alguma",
  "algum",
  "outro",
  "outra",
]);

const TOKEN_ALIASES: Record<string, string> = {
  contexto: "context",
  contextos: "context",
  caching: "cache",
  cached: "cache",
  caches: "cache",
  compressao: "compression",
  comprimir: "compression",
  compressed: "compression",
  semantica: "semantic",
  semantico: "semantic",
  analise: "analysis",
  analisar: "analysis",
  concorrencia: "concurrency",
  concorrente: "concurrency",
  concurrent: "concurrency",
  fairness: "scheduling",
  scheduler: "scheduling",
  scheduling: "scheduling",
  starvation: "liveness",
  travado: "liveness",
  travada: "liveness",
  stuck: "liveness",
  progresso: "progress",
  retrievals: "retrieval",
  recuperacao: "retrieval",
  referencia: "reference",
  referencias: "reference",
  deterministico: "deterministic",
  deterministica: "deterministic",
  aggressive: "aggressive",
  agressivo: "aggressive",
  agressiva: "aggressive",
};

const INTENT_ALIASES: Array<[string, string[]]> = [
  ["fix", ["fix", "corrigir", "corrija", "resolver", "repair", "ajustar", "ajuste"]],
  ["debug", ["debug", "investigar", "investigue", "diagnosticar", "diagnose"]],
  ["refactor", ["refactor", "refatorar", "refatore"]],
  ["implement", ["implement", "implementar", "implemente", "adicionar", "add", "create", "criar"]],
  ["optimize", ["optimize", "otimizar", "otimize", "reduzir", "reduce", "compress"]],
  ["test", ["test", "testar", "teste", "validate", "validar"]],
  ["document", ["document", "documentar", "docs", "documentation"]],
];

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function extractFiles(task: string): string[] {
  const matches = task.match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|json|md|yaml|yml|toml)\b/g) ?? [];
  return [...new Set(matches.map((value) => value.replaceAll("\\", "/")))].sort();
}

function extractSymbols(task: string): string[] {
  const dotted = task.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g) ?? [];
  const camel = task.match(/\b[A-Z][A-Za-z0-9_$]{2,}\b/g) ?? [];
  return [...new Set([...dotted, ...camel].filter((value) => !value.includes("/")))].sort();
}

function rawTokens(task: string): string[] {
  return normalizeText(task)
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function detectIntent(tokens: string[]): string {
  for (const [intent, aliases] of INTENT_ALIASES) {
    if (aliases.some((alias) => tokens.includes(alias))) return intent;
  }
  return "inspect";
}

function canonicalTokens(task: string): string[] {
  const intentWords = new Set(INTENT_ALIASES.flatMap(([, aliases]) => aliases));
  return [
    ...new Set(
      rawTokens(task)
        .filter((token) => token.length > 2)
        .filter((token) => !STOP_WORDS.has(token))
        .filter((token) => !intentWords.has(token))
        .map((token) => TOKEN_ALIASES[token] ?? token),
    ),
  ].sort();
}

function detectDomains(tokens: string[]): string[] {
  const tokenSet = new Set(tokens);
  const domains: string[] = [];
  if (tokenSet.has("context") || tokenSet.has("retrieval") || tokenSet.has("reference")) {
    domains.push("context-engine");
  }
  if (tokenSet.has("cache")) domains.push("cache");
  if (tokenSet.has("headroom") || tokenSet.has("compression")) domains.push("compression");
  if (tokenSet.has("semantic") && tokenSet.has("analysis")) domains.push("semantic-analysis");
  if (tokenSet.has("gpu") || tokenSet.has("vram")) domains.push("compute-runtime");
  if (tokenSet.has("scheduling") || tokenSet.has("liveness") || tokenSet.has("concurrency")) {
    domains.push("scheduling");
  }
  if (tokenSet.has("eta")) domains.push("eta");
  return [...new Set(domains)].sort();
}

function detectLanguage(task: string): string {
  const lower = task.toLowerCase();
  if (/\.tsx?\b/.test(lower) || /\.jsx?\b/.test(lower) || /typescript|nestjs|node(?:\.js)?/.test(lower)) {
    return "typescript";
  }
  if (/\.py\b/.test(lower) || /python|fastapi|django/.test(lower)) {
    return "python";
  }
  if (/\.rs\b/.test(lower) || /\brust\b/.test(lower)) {
    return "rust";
  }
  return "unknown";
}

function buildSignature(task: string, concepts: string[], detectedLanguage: string): TaskSignature {
  const tokens = rawTokens(task);
  const intent = detectIntent(tokens);
  const domains = detectDomains(concepts);
  const files = extractFiles(task);
  const symbols = extractSymbols(task);
  const lower = normalizeText(task);
  const externalLibraries = EXTERNAL_LIB_KEYWORDS.filter((keyword) => lower.includes(keyword)).sort();
  const canonicalQuery = concepts.join(" ");
  const identity = {
    version: 1 as const,
    intent,
    domains,
    files,
    symbols,
    external_libraries: externalLibraries,
    language: detectedLanguage,
    canonical_query: canonicalQuery,
  };
  return {
    ...identity,
    fingerprint: createCacheKey("task-signature:v1", identity),
    component_scope: createCacheKey("task-component-scope:v1", {
      domains,
      external_libraries: externalLibraries,
      language: detectedLanguage,
    }),
  };
}

export function analyzeTask(task: string): TaskAnalysis {
  const concepts = canonicalTokens(task);
  const detectedLanguage = detectLanguage(task);
  const signature = buildSignature(task, concepts, detectedLanguage);

  return {
    concepts,
    external_api_needed: signature.external_libraries.length > 0,
    detected_language: detectedLanguage,
    signature,
  };
}
