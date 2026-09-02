import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const nowIso = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}-${randomUUID()}`;
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const estimateTokens = (bytes) => Math.ceil(bytes / 4);
export const runtimeTaskDirectoryName = (taskId, agentId = "task") => {
  const agent = String(agentId).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  return `${agent}--${sha256(String(taskId)).slice(0, 12)}`;
};

export async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizeRelativePath(root, path) {
  const normalized = relative(resolve(root), resolve(path)).split(sep).join("/");
  if (normalized === "" || (!normalized.startsWith("../") && normalized !== "..")) return normalized;
  throw new Error(`path_outside_repository:${path}`);
}

export function patternMatches(pattern, candidate) {
  const cleanPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const cleanCandidate = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
  if (cleanPattern === cleanCandidate) return true;
  if (cleanPattern.endsWith("/**")) return cleanCandidate.startsWith(cleanPattern.slice(0, -2));
  if (!cleanPattern.includes("*")) return false;
  const escaped = cleanPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "::DOUBLE_STAR::")
    .replaceAll("*", "[^/]*")
    .replaceAll("::DOUBLE_STAR::", ".*");
  return new RegExp(`^${escaped}$`).test(cleanCandidate);
}

export function anyPatternMatches(patterns, candidate) {
  return patterns.some((pattern) => patternMatches(pattern, candidate));
}

export async function listFiles(root, options = {}) {
  const ignored = new Set(options.ignored ?? [".git", ".runtime", "dist", "node_modules", "release", "target"]);
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(root);
  return result;
}

export async function fileFingerprint(path) {
  if (!(await exists(path))) return null;
  const info = await stat(path);
  if (!info.isFile()) return null;
  const content = await readFile(path);
  return { sha256: sha256(content), bytes: content.byteLength };
}

export function sameFileFingerprint(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left == null && right == null;
  return String(left.sha256 ?? "") === String(right.sha256 ?? "")
    && Number(left.bytes ?? -1) === Number(right.bytes ?? -1);
}

export async function snapshotFiles(root, patterns = ["**"]) {
  const snapshot = new Map();
  for (const absolute of await listFiles(root)) {
    const rel = normalizeRelativePath(root, absolute);
    if (patterns.length > 0 && !anyPatternMatches(patterns, rel) && !patterns.includes("**")) continue;
    snapshot.set(rel, await fileFingerprint(absolute));
  }
  return snapshot;
}

export async function removeIfExists(path) {
  if (await exists(path)) await rm(path, { recursive: true, force: true });
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [rawKey, inline] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) {
      args[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function asInteger(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}


export async function loadEnvFile(path) {
  if (!(await exists(path))) return;
  const content = await readFile(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function resolveRepositoryRoot(start = process.cwd()) {
  return resolve(start);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  return `${(seconds / 60).toFixed(2)} min`;
}
