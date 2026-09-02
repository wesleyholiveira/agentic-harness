#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const manifestPath = resolve(root, "MANIFEST.json");
const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : "print";

const excludedDirectories = new Set([".git", ".runtime", "node_modules", "target", ".target"]);
const excludedFiles = new Set([".env", "MANIFEST.json"]);
const posix = (value) => value.split(sep).join("/");
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    const rel = posix(relative(root, absolute));
    if (entry.isDirectory()) {
      output.push(...await walk(absolute));
      continue;
    }
    if (!entry.isFile() || excludedFiles.has(rel)) continue;
    const bytes = await readFile(absolute);
    output.push({ bytes: bytes.byteLength, path: rel, sha256: digest(bytes) });
  }
  return output;
}

const files = (await walk(root)).sort((a, b) => a.path.localeCompare(b.path));
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
  fileCount: files.length,
  treeSha256,
  treeHashAlgorithm: "sha256(canonical-json(files sorted by path; keys sorted; UTF-8; compact separators))",
  exclusions: [".git/", ".runtime/", "node_modules/", "target/", ".target/", ".env", "MANIFEST.json (self)"],
  files,
};

if (mode === "write") {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, code: "agent_harness_manifest_written", fileCount: files.length, treeSha256, manifestPath }, null, 2));
  process.exit(0);
}

if (mode === "check") {
  if (!existsSync(manifestPath)) {
    console.error(JSON.stringify({ ok: false, code: "agent_harness_manifest_missing", manifestPath }, null, 2));
    process.exit(2);
  }
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  const currentFiles = Array.isArray(current.files) ? current.files.map(({ bytes, path, sha256 }) => ({ bytes, path, sha256 })) : [];
  const same = current.treeSha256 === treeSha256 && JSON.stringify(currentFiles) === JSON.stringify(canonicalFiles);
  console.log(JSON.stringify({
    ok: same,
    code: same ? "agent_harness_manifest_matches_source" : "agent_harness_manifest_source_mismatch",
    expectedFileCount: files.length,
    manifestFileCount: currentFiles.length,
    expectedTreeSha256: treeSha256,
    manifestTreeSha256: current.treeSha256 ?? null,
  }, null, 2));
  process.exit(same ? 0 : 1);
}

console.log(JSON.stringify({ fileCount: files.length, treeSha256, files }, null, 2));
