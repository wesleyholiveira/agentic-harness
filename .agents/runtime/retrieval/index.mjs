import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { listFiles, normalizeRelativePath, sha256 } from "../utils.mjs";

const INDEX_VERSION = 1;
const SCORER_VERSION = "lexical-v1";
const ignoredDirectories = [".git", ".runtime", "node_modules", "dist", "release", "target", "models", "media", "cache", "caches", "__pycache__"];
const textExtensions = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsx", ".md", ".mjs",
  ".py", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const textNames = new Set(["Dockerfile", "LICENSE", "Makefile", ".env.example", ".gitignore", ".dockerignore"]);

export function normalizeLexicalText(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function lexicalTerms(value) {
  const stop = new Set(["a", "ao", "aos", "as", "de", "da", "das", "do", "dos", "e", "em", "o", "os", "para", "por", "um", "uma", "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with"]);
  return [...new Set(normalizeLexicalText(value).split(" ").filter((term) => term.length > 1 && !stop.has(term)))];
}

function isTextCandidate(relativePath, bytes) {
  if (bytes > 1_500_000) return false;
  const name = basename(relativePath);
  return textNames.has(name) || textExtensions.has(extname(name).toLowerCase());
}

function detectBoundary(line, extension) {
  const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (heading) return { kind: "heading", title: heading[2].replace(/#+$/, "").trim() };

  const patterns = extension === ".py"
    ? [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/]
    : extension === ".rs"
      ? [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/]
      : [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match) return { kind: "symbol", title: match[1] };
  }
  const route = /^\s*@app\.(get|post|put|patch|delete)\(["']([^"']+)/.exec(line);
  if (route) return { kind: "route", title: `${route[1].toUpperCase()} ${route[2]}` };
  return null;
}

function makeChunk(relativePath, fileHash, lines, start, end, boundary, index) {
  const content = lines.slice(start, end).join("\n");
  const title = boundary?.title ?? `${basename(relativePath)}:${start + 1}`;
  const symbols = boundary?.kind === "symbol" ? [title] : [];
  const terms = lexicalTerms(`${relativePath} ${title} ${content}`).slice(0, 800);
  return {
    chunkId: sha256(`${relativePath}:${fileHash}:${start + 1}:${end}:${index}`),
    startLine: start + 1,
    endLine: end,
    kind: boundary?.kind ?? "block",
    title,
    symbols,
    bytes: Buffer.byteLength(content),
    terms,
  };
}

export function chunkText(relativePath, content, fileHash) {
  const lines = content.split(/\r?\n/);
  const extension = extname(relativePath).toLowerCase();
  const boundaries = [{ line: 0, boundary: null }];
  for (let index = 0; index < lines.length; index += 1) {
    const boundary = detectBoundary(lines[index] ?? "", extension);
    if (boundary && index !== 0) boundaries.push({ line: index, boundary });
    else if (boundary && index === 0) boundaries[0] = { line: 0, boundary };
  }
  const chunks = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index].line;
    const naturalEnd = boundaries[index + 1]?.line ?? lines.length;
    for (let cursor = start; cursor < naturalEnd; cursor += 120) {
      const end = Math.min(naturalEnd, cursor + 120);
      chunks.push(makeChunk(relativePath, fileHash, lines, cursor, end, cursor === start ? boundaries[index].boundary : null, chunks.length));
    }
  }
  return chunks.length > 0 ? chunks : [makeChunk(relativePath, fileHash, lines, 0, lines.length, null, 0)];
}

async function readExistingIndex(indexFile) {
  try {
    const parsed = JSON.parse(await readFile(indexFile, "utf8"));
    return parsed.version === INDEX_VERSION && parsed.scorerVersion === SCORER_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export async function buildLexicalIndex({ repositoryRoot, indexPath, force = false }) {
  const started = performance.now();
  const indexFile = join(indexPath, "index-v1.json");
  const existing = force ? null : await readExistingIndex(indexFile);
  const priorByPath = new Map((existing?.files ?? []).map((file) => [file.path, file]));
  const files = [];
  let reusedFiles = 0;
  let indexedFiles = 0;

  const normalizedRepositoryRoot = resolve(repositoryRoot);
  const normalizedIndexPath = resolve(indexPath);
  const candidates = await listFiles(repositoryRoot, { ignored: ignoredDirectories });
  for (const absolute of candidates.sort()) {
    const resolvedAbsolute = resolve(absolute);
    const relativeToIndex = relative(normalizedIndexPath, resolvedAbsolute);
    if (relativeToIndex === "" || (!relativeToIndex.startsWith(`..${sep}`) && relativeToIndex !== "..")) continue;
    const relativeToRepository = relative(normalizedRepositoryRoot, resolvedAbsolute);
    if (relativeToRepository.startsWith(`..${sep}`) || relativeToRepository === "..") continue;
    const relativePath = normalizeRelativePath(repositoryRoot, absolute);
    const info = await stat(absolute);
    if (!isTextCandidate(relativePath, info.size)) continue;
    const content = await readFile(absolute, "utf8");
    if (content.includes("\0")) continue;
    const fileHash = sha256(content);
    const prior = priorByPath.get(relativePath);
    if (prior?.sha256 === fileHash) {
      files.push(prior);
      reusedFiles += 1;
      continue;
    }
    files.push({
      path: relativePath,
      sha256: fileHash,
      bytes: info.size,
      chunks: chunkText(relativePath, content, fileHash),
    });
    indexedFiles += 1;
  }

  const index = {
    version: INDEX_VERSION,
    scorerVersion: SCORER_VERSION,
    createdAt: new Date().toISOString(),
    repositoryFingerprint: sha256(files.map((file) => `${file.path}:${file.sha256}`).join("\n")),
    files,
    stats: {
      fileCount: files.length,
      chunkCount: files.reduce((sum, file) => sum + file.chunks.length, 0),
      reusedFiles,
      indexedFiles,
      buildLatencyMs: performance.now() - started,
    },
  };
  await mkdir(dirname(indexFile), { recursive: true });
  await writeFile(indexFile, `${JSON.stringify(index)}\n`, "utf8");
  return { index, indexFile };
}

export async function loadOrBuildLexicalIndex(options) {
  return buildLexicalIndex(options);
}
