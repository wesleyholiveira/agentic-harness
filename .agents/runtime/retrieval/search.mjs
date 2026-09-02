import { basename } from "node:path";
import { lexicalTerms, normalizeLexicalText } from "./index.mjs";
import { patternMatches } from "../utils.mjs";

function scoreChunk({ file, chunk, query, queryTerms, pathHints }) {
  const normalizedPath = normalizeLexicalText(file.path);
  const normalizedName = normalizeLexicalText(basename(file.path));
  const normalizedTitle = normalizeLexicalText(chunk.title);
  const chunkTerms = new Set(chunk.terms);
  let score = 0;
  const provenance = [];

  for (const term of queryTerms) {
    if (normalizedName.split(" ").includes(term)) { score += 12; provenance.push(`name:${term}`); }
    else if (normalizedPath.includes(term)) { score += 8; provenance.push(`path:${term}`); }
    if (normalizedTitle.includes(term)) { score += 7; provenance.push(`title:${term}`); }
    if (chunk.symbols.some((symbol) => normalizeLexicalText(symbol) === term)) { score += 12; provenance.push(`symbol:${term}`); }
    if (chunkTerms.has(term)) { score += 2; provenance.push(`term:${term}`); }
  }

  const normalizedQuery = normalizeLexicalText(query);
  if (normalizedQuery.length > 5 && `${normalizedPath} ${normalizedTitle}`.includes(normalizedQuery)) {
    score += 18;
    provenance.push("exact-phrase");
  }
  for (const hint of pathHints) {
    if (patternMatches(hint, file.path)) {
      score += 5;
      provenance.push(`agent-path:${hint}`);
      break;
    }
  }
  return { score, provenance: [...new Set(provenance)] };
}

export function searchLexicalIndex({ index, query, registry = null, agentIds = [], topK = 20, maxCandidateBytes = 400_000 }) {
  const started = performance.now();
  const queryTerms = lexicalTerms(query);
  const pathHints = [];
  for (const agentId of agentIds) {
    const agent = registry?.byId?.get(agentId) ?? registry?.agents?.find((candidate) => candidate.id === agentId);
    pathHints.push(...(agent?.routing?.pathHints ?? []), ...(agent?.primaryPaths ?? []));
  }

  const ranked = [];
  for (const file of index.files) {
    for (const chunk of file.chunks) {
      const { score, provenance } = scoreChunk({ file, chunk, query, queryTerms, pathHints });
      if (score <= 0) continue;
      ranked.push({
        path: file.path,
        fileSha256: file.sha256,
        chunkId: chunk.chunkId,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        title: chunk.title,
        kind: chunk.kind,
        bytes: chunk.bytes,
        score,
        provenance,
      });
    }
  }
  ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.startLine - right.startLine);

  const results = [];
  const seenPaths = new Set();
  let bytes = 0;
  for (const candidate of ranked) {
    if (seenPaths.has(candidate.path)) continue;
    if (results.length >= topK) break;
    if (bytes + candidate.bytes > maxCandidateBytes && results.length > 0) continue;
    seenPaths.add(candidate.path);
    results.push(candidate);
    bytes += candidate.bytes;
  }
  return {
    query,
    queryTerms,
    results,
    discoveredContextBytes: bytes,
    latencyMs: performance.now() - started,
    fallbackUsed: results.length === 0,
  };
}
