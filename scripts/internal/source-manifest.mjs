#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const manifestPath = resolve(root, "MANIFEST.json");
const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : "print";
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const normalizePath = (value) => String(value).replaceAll("\\", "/");

function git(args, options = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    const stdout = String(error?.stdout ?? "").trim();
    const message = stderr || stdout || String(error?.message ?? error);
    const wrapped = new Error(message);
    wrapped.code = "agent_harness_git_source_unavailable";
    throw wrapped;
  }
}

function gitPaths(args) {
  return git([...args, "-z"])
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort((a, b) => a.localeCompare(b));
}

function assertGitWorktree() {
  const inside = git(["rev-parse", "--is-inside-work-tree"]).trim();
  if (inside !== "true") {
    const error = new Error("Agentic Harness source manifest requires a Git worktree.");
    error.code = "agent_harness_git_source_required";
    throw error;
  }
}

assertGitWorktree();

const trackedPaths = gitPaths(["ls-files"]);
const manifestTracked = trackedPaths.includes("MANIFEST.json");
const sourcePaths = trackedPaths.filter((path) => path !== "MANIFEST.json");
const untrackedNonIgnored = gitPaths(["ls-files", "--others", "--exclude-standard"]);
const gitStatus = git(["status", "--porcelain=v1", "--untracked-files=all"]);
const gitStatusClean = gitStatus.trim().length === 0;

async function buildFiles() {
  const output = [];
  for (const path of sourcePaths) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) {
      const error = new Error(`Tracked source path is missing from the worktree: ${path}`);
      error.code = "agent_harness_tracked_source_missing";
      throw error;
    }
    const info = await stat(absolute);
    if (!info.isFile()) continue;
    const bytes = await readFile(absolute);
    output.push({ bytes: bytes.byteLength, path, sha256: digest(bytes) });
  }
  return output;
}

const files = await buildFiles();
const canonicalFiles = files.map(({ bytes, path, sha256 }) => ({ bytes, path, sha256 }));
const treeSha256 = digest(Buffer.from(JSON.stringify(canonicalFiles), "utf8"));

let previous = {};
if (existsSync(manifestPath)) {
  previous = JSON.parse(await readFile(manifestPath, "utf8"));
}
const manifest = {
  ...previous,
  schemaVersion: previous.schemaVersion || "agentic-harness-distribution-manifest/v1",
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  packageName: previous.packageName || "agentic-harness",
  packageVersion: previous.packageVersion || "1.0.0",
  distributionStatus: previous.distributionStatus || "SOURCE_CANDIDATE_READY_FOR_TARGET_HOST_QUALIFICATION",
  sourceAuthority: "git-tracked-worktree",
  fileCount: files.length,
  treeSha256,
  treeHashAlgorithm: "sha256(canonical-json(git tracked files excluding MANIFEST.json, sorted by path; UTF-8; compact separators))",
  exclusions: ["MANIFEST.json (self)", "all Git-ignored/untracked local state"],
  files,
};

if (mode === "write") {
  if (!manifestTracked && existsSync(manifestPath)) {
    // First/bootstrap writes may occur before MANIFEST.json itself is staged. The
    // subsequent --check requires the manifest to be tracked and the worktree clean.
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    code: "agent_harness_manifest_written",
    sourceAuthority: manifest.sourceAuthority,
    fileCount: files.length,
    treeSha256,
    manifestPath,
    manifestTracked,
    untrackedNonIgnored,
  }, null, 2));
  process.exit(0);
}

if (mode === "check") {
  if (!existsSync(manifestPath)) {
    console.error(JSON.stringify({ ok: false, code: "agent_harness_manifest_missing", manifestPath }, null, 2));
    process.exit(2);
  }
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  const currentFiles = Array.isArray(current.files) ? current.files.map(({ bytes, path, sha256 }) => ({ bytes, path, sha256 })) : [];
  const sourceMatches = current.treeSha256 === treeSha256 && JSON.stringify(currentFiles) === JSON.stringify(canonicalFiles);
  const authorityMatches = current.sourceAuthority === "git-tracked-worktree";
  const parityOk = manifestTracked && untrackedNonIgnored.length === 0;
  const ok = sourceMatches && authorityMatches && parityOk && gitStatusClean;
  let code = "agent_harness_manifest_matches_git_source";
  if (!manifestTracked) code = "agent_harness_manifest_not_tracked";
  else if (untrackedNonIgnored.length > 0) code = "agent_harness_untracked_source_present";
  else if (!gitStatusClean) code = "agent_harness_git_worktree_dirty";
  else if (!authorityMatches) code = "agent_harness_manifest_authority_mismatch";
  else if (!sourceMatches) code = "agent_harness_manifest_source_mismatch";
  console.log(JSON.stringify({
    ok,
    code,
    sourceAuthority: current.sourceAuthority ?? null,
    trackedTotal: trackedPaths.length,
    trackedSourceExcludingManifest: sourcePaths.length,
    manifestTracked,
    untrackedNonIgnored,
    gitStatusClean,
    expectedFileCount: files.length,
    manifestFileCount: currentFiles.length,
    expectedTreeSha256: treeSha256,
    manifestTreeSha256: current.treeSha256 ?? null,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log(JSON.stringify({
  sourceAuthority: "git-tracked-worktree",
  trackedTotal: trackedPaths.length,
  manifestTracked,
  untrackedNonIgnored,
  gitStatusClean,
  fileCount: files.length,
  treeSha256,
  files,
}, null, 2));
