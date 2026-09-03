import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const PLUGIN_ID = "agentic-harness.runtime-invocation-provenance";
const LIVE_SCHEMA = "runtime-invocation-provenance-live/v1";
const projectRoot = resolve(
  process.env.AGENT_HARNESS_PROJECT_ROOT?.trim()
    || process.env.AGENT_HARNESS_REPOSITORY_ROOT?.trim()
    || process.cwd(),
);
const harnessRoot = resolve(process.env.AGENT_HARNESS_ROOT?.trim() || projectRoot);
const pluginPath = resolve(harnessRoot, ".opencode/plugins/runtime-invocation-provenance.js");
const recordPath = resolve(
  process.env.AGENT_HARNESS_RUNTIME_PROVENANCE_LIVE_RECORD?.trim()
    || resolve(projectRoot, ".runtime/agents/runtime-invocation-provenance-live.json"),
);

function canonicalFsPath(value) {
  const input = resolve(String(value ?? "").trim());
  return typeof realpathSync.native === "function"
    ? realpathSync.native(input)
    : realpathSync(input);
}

function fsPathIdentity(value) {
  try {
    const canonical = canonicalFsPath(value);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return null;
  }
}

function fail(code, details = {}) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code,
    repositoryRoot: projectRoot,
    harnessRoot,
    pluginPath,
    recordPath,
    operatorAction: "Restart the persistent OpenCode host after source/plugin changes, then attach a fresh TUI session before R-0.",
    ...details,
  }, null, 2)}\n`);
  process.exitCode = 1;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    return false;
  }
}

try {
  const [pluginBytes, rawRecord] = await Promise.all([
    readFile(pluginPath),
    readFile(recordPath, "utf8"),
  ]);
  const canonicalProjectRoot = canonicalFsPath(projectRoot);
  const canonicalHarnessRoot = canonicalFsPath(harnessRoot);
  const canonicalPlugin = canonicalFsPath(pluginPath);
  const record = JSON.parse(rawRecord);
  const expectedSourceSha256 = `sha256:${createHash("sha256").update(pluginBytes).digest("hex")}`;
  const processId = Number(record?.processId);
  const loadedAtMs = Date.parse(String(record?.loadedAt ?? ""));
  const checks = {
    schema: record?.schemaVersion === LIVE_SCHEMA,
    pluginId: record?.pluginId === PLUGIN_ID,
    sourceSha: record?.pluginSourceSha256 === expectedSourceSha256,
    repositoryRoot: fsPathIdentity(record?.repositoryRoot) === fsPathIdentity(canonicalProjectRoot),
    harnessRoot: fsPathIdentity(record?.harnessRoot) === fsPathIdentity(canonicalHarnessRoot),
    pluginPath: fsPathIdentity(record?.pluginPath) === fsPathIdentity(canonicalPlugin),
    processId: Number.isInteger(processId) && processId > 0,
    processAlive: Number.isInteger(processId) && processId > 0 && processAlive(processId),
    loadedAt: Number.isFinite(loadedAtMs) && loadedAtMs <= Date.now(),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    fail("agent_runtime_invocation_provenance_live_identity_mismatch", {
      expectedSourceSha256,
      loadedSourceSha256: record?.pluginSourceSha256 ?? null,
      processId: Number.isFinite(processId) ? processId : null,
      loadedAt: record?.loadedAt ?? null,
      failedChecks: failed,
    });
  } else {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      code: "agent_runtime_invocation_provenance_live_identity_ready",
      repositoryRoot: canonicalProjectRoot,
      harnessRoot: canonicalHarnessRoot,
      pluginPath: canonicalPlugin,
      recordPath,
      pluginSourceSha256: expectedSourceSha256,
      processId,
      loadedAt: record.loadedAt,
      checks,
    }, null, 2)}\n`);
  }
} catch (error) {
  fail("agent_runtime_invocation_provenance_live_identity_unavailable", {
    error: error instanceof Error ? error.message : String(error),
  });
}
