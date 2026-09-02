import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("OpenCode config is portable and uses pinned integrations", () => {
  assert.equal(existsSync(resolve(root, "opencode.json")), false, "root opencode.json must not be auto-discoverable");
  assert.equal(existsSync(resolve(root, "opencode.jsonc")), false, "root opencode.jsonc must not be auto-discoverable");
  const source = readFileSync(resolve(root, "config", "opencode.template.jsonc"), "utf8");
  assert.equal(/ctx7sk-|C:\\Users\\|D:\\/i.test(source), false);
  assert.match(source, /CONTEXT7_API_KEY/);
  assert.match(source, /serena-agent==1\.7\.0/);
  assert.match(source, /headroom-ai\[mcp\]==0\.36\.5/);
  assert.match(source, /X-Agentic-Harness-Agent-Id/);
  assert.match(source, /vendor\/superpowers\/skills/);
  const dockerfile = readFileSync(resolve(root, "apps", "runtime-worker", "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY config \.\/config/);
  assert.equal(/COPY .*opencode\.jsonc/.test(dockerfile), false);
});

test("host and consuming-project roots are distinct runtime concepts", () => {
  const server = readFileSync(resolve(root, "apps/context-engine/src/server.ts"), "utf8");
  const control = readFileSync(resolve(root, ".agents/runtime/control-plane.mjs"), "utf8");
  assert.match(server, /AGENT_HARNESS_PROJECT_ROOT/);
  assert.match(server, /AGENT_HARNESS_ROOT/);
  assert.match(control, /harnessRoot/);
  assert.match(control, /repositoryRoot/);
});


test("OpenCode effective config is generated safely for Windows-shaped project roots", () => {
  const runtimeFile = resolve(root, ".runtime", "opencode.effective.json");
  rmSync(runtimeFile, { force: true });
  const result = spawnSync(process.execPath, [resolve(root, "scripts", "generate-opencode-config.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_HARNESS_ROOT: root,
      AGENT_HARNESS_PROJECT_ROOT: "D:\\consumer project",
      AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL: "",
      CONTEXT7_API_KEY: "",
      HEADROOM_PROXY_PORT: "18893",
      CODEBASE_MEMORY_MCP_COMMAND: process.execPath,
    },
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = (result.stdout || "").trim().split(/\r?\n/).at(-1);
  const config = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(config.mcp["context-engine"].url, "http://127.0.0.1:8789/mcp");
  assert.equal(config.mcp.context7.enabled, false);
  assert.equal("headers" in config.mcp.context7, false);
  assert.equal(config.instructions.every((value) => !value.includes("\\")), true);
  assert.equal(config.skills.paths.every((value) => !value.includes("\\")), true);
  assert.deepEqual(config.mcp.headroom.command.slice(-2), ["--proxy-url", "http://127.0.0.1:18893"]);
  assert.match(config.mcp.headroom.command.join(" "), /headroom-ai\[mcp\]==0\.36\.5/);
  const cbmCommand = config.mcp["codebase-memory-mcp"].command[0];
  assert.equal(cbmCommand, process.execPath.replaceAll("\\", "/"));
});


test("doctor treats codebase-memory-mcp as an MCP server, not a --version CLI", () => {
  const source = readFileSync(resolve(root, "scripts", "harness-doctor.mjs"), "utf8");
  assert.match(source, /codebaseMemoryResolved/);
  assert.match(source, /mcpHandshake: "not-run-by-doctor"/);
  assert.equal(/probe\(codebaseMemoryExecutable/.test(source), false);
});

test("source manifest can be regenerated after pre-R0 dependency vendoring", () => {
  const source = readFileSync(resolve(root, "scripts", "internal", "source-manifest.mjs"), "utf8");
  assert.match(source, /agent_harness_manifest_written/);
  assert.match(source, /agent_harness_manifest_matches_source/);
  assert.match(source, /MANIFEST\.json/);
});


test("Git checkout normalization preserves cross-platform source fingerprints", () => {
  const attributes = readFileSync(resolve(root, ".gitattributes"), "utf8");
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.zip binary$/m);
});
