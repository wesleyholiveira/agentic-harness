import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".runtime", "qualification", ".git"].includes(name)) continue;
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path)); else out.push(path);
  }
  return out;
}

test("standalone boundary excludes monolithic registry and product applications", () => {
  assert.equal(existsSync(resolve(root, ".agents/registry.json")), false);
  for (const path of ["apps/web", "apps/server", "apps/ml"]) assert.equal(existsSync(resolve(root, path)), false);
});

test("package exposes a bounded stable command surface", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.ok(Object.keys(pkg.scripts).length <= 12);
  assert.ok(Object.keys(pkg.scripts).every((key) => key.startsWith("harness:")));
});

test("operational source is project-agnostic", () => {
  const legacyProductPattern = ["clip", "compass"].join("[ _-]");
  const forbidden = new RegExp(`${legacyProductPattern}|api-media-gateway|semantic-intelligence|temporal-intelligence|learning-model-lifecycle|transcription-ml`, "i");
  const failures = [];
  for (const path of walk(root)) {
    if (path.includes(`${resolve(root, "tests")}`)) continue;
    if (path === resolve(root, "DISTRIBUTION-REPORT.md")) continue; // extraction provenance, not operational authority
    if (!/\.(?:mjs|js|ts|tsx|json|jsonc|md|rs|toml|ya?ml|example)$/.test(path)) continue;
    const text = readFileSync(path, "utf8");
    if (forbidden.test(text)) failures.push(relative(root, path));
  }
  assert.deepEqual(failures, []);

  const agentTools = readFileSync(resolve(root, ".agents/runtime/mcp/agent-tools.mjs"), "utf8");
  for (const tool of [
    "agent_harness_agents_status",
    "agent_harness_agents_summary",
    "agent_harness_agents_validate_artifact",
    "agent_harness_agents_doctor",
  ]) assert.match(agentTools, new RegExp(`\\b${tool}\\b`));

  const metrics = readFileSync(resolve(root, ".agents/runtime/metrics.mjs"), "utf8");
  assert.match(metrics, /agent_harness_runs_total/);
  assert.match(metrics, /agent_harness_metrics_exporter_up/);
});

test("qualification baseline preserves promoted fingerprint", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "qualification/baseline/r17.4.5/source-manifest.json"), "utf8"));
  assert.equal(manifest.sourceSha256, "sha256:2030a87202a3dc5b877c7860f5374edeb97ca52f83ea9d324dc82b13ce2b5abf");
});
