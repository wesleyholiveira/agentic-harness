import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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


test("OpenCode effective config is generated under the consuming project runtime root", () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), "agentic-harness-consumer with space-"));
  const harnessRuntimeFile = resolve(root, ".runtime", "opencode.effective.json");
  rmSync(harnessRuntimeFile, { force: true });
  try {
    const result = spawnSync(process.execPath, [resolve(root, "scripts", "generate-opencode-config.mjs")], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        AGENT_HARNESS_ROOT: root,
        AGENT_HARNESS_PROJECT_ROOT: consumerRoot,
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
    const expectedOutput = resolve(consumerRoot, ".runtime", "opencode.effective.json");
    assert.equal(resolve(output), expectedOutput);
    assert.equal(existsSync(expectedOutput), true);
    assert.equal(existsSync(harnessRuntimeFile), false, "generated runtime evidence must not be written under AGENT_HARNESS_ROOT");

    const config = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(config.default_agent, "main-orchestrator");
    assert.equal(Object.keys(config.agent ?? {}).length, 20);
    assert.deepEqual(config.skills.paths, [
      resolve(root, ".agents/skills").replaceAll("\\", "/"),
      resolve(root, "vendor/superpowers/skills").replaceAll("\\", "/"),
    ]);
    assert.ok(config.plugin.includes("superpowers@git+https://github.com/obra/superpowers.git#v5.1.0"));
    assert.equal(config.mcp["context-engine"].url, "http://127.0.0.1:8789/mcp");
    assert.equal(config.mcp.context7.enabled, false);
    assert.equal("headers" in config.mcp.context7, false);
    assert.equal(config.instructions.every((value) => !value.includes("\\")), true);
    assert.equal(config.skills.paths.every((value) => !value.includes("\\")), true);
    assert.deepEqual(config.mcp.headroom.command.slice(-2), ["--proxy-url", "http://127.0.0.1:18893"]);
    assert.match(config.mcp.headroom.command.join(" "), /headroom-ai\[mcp\]==0\.36\.5/);
    const cbmCommand = config.mcp["codebase-memory-mcp"].command[0];
    assert.equal(cbmCommand, process.execPath.replaceAll("\\", "/"));
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
    rmSync(harnessRuntimeFile, { force: true });
  }
});

test("harness clean removes only harness-owned runtime artifacts from the consuming project", () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), "agentic-harness-clean-consumer-"));
  try {
    mkdirSync(resolve(consumerRoot, ".runtime", "agents", "runs"), { recursive: true });
    writeFileSync(resolve(consumerRoot, ".runtime", "agents", "runs", "run.json"), "{}\n");
    writeFileSync(resolve(consumerRoot, ".runtime", "opencode.effective.json"), "{}\n");
    writeFileSync(resolve(consumerRoot, ".runtime", "consumer-owned.keep"), "keep\n");
    const result = spawnSync(process.execPath, [resolve(root, "bin", "harness.mjs"), "clean"], {
      cwd: consumerRoot,
      env: { ...process.env, AGENT_HARNESS_PROJECT_ROOT: consumerRoot },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(resolve(consumerRoot, ".runtime", "agents")), false);
    assert.equal(existsSync(resolve(consumerRoot, ".runtime", "opencode.effective.json")), false);
    assert.equal(existsSync(resolve(consumerRoot, ".runtime", "consumer-owned.keep")), true);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});

test("persistent OpenCode provenance keeps harness plugin authority and project runtime evidence separate", () => {
  const plugin = readFileSync(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js"), "utf8");
  const checker = readFileSync(resolve(root, "scripts/internal/agent-runtime-invocation-provenance-live-check.mjs"), "utf8");
  assert.match(plugin, /AGENT_HARNESS_ROOT/);
  assert.match(plugin, /AGENT_HARNESS_PROJECT_ROOT/);
  assert.match(plugin, /AGENT_HARNESS_OPENCODE_RUNTIME_CHILD/);
  assert.match(plugin, /resolve\(harnessRoot, "\.opencode\/plugins\/runtime-invocation-provenance\.js"\)/);
  assert.match(plugin, /resolve\(projectRoot, LIVE_IDENTITY_RELATIVE_PATH\)/);
  assert.match(checker, /AGENT_HARNESS_ROOT/);
  assert.match(checker, /AGENT_HARNESS_PROJECT_ROOT/);
  assert.match(checker, /resolve\(projectRoot, "\.runtime\/agents\/runtime-invocation-provenance-live\.json"\)/);
});

test("persistent provenance live identity is materialized in the consumer and validates against the harness plugin", () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), "agentic-harness-provenance-consumer-"));
  try {
    const pluginUrl = pathToFileURL(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js")).href;
    const checkerUrl = pathToFileURL(resolve(root, "scripts/internal/agent-runtime-invocation-provenance-live-check.mjs")).href;
    const script = `
      const { RuntimeInvocationProvenance } = await import(${JSON.stringify(pluginUrl)});
      await RuntimeInvocationProvenance({ serverUrl: new URL("http://127.0.0.1:4096"), directory: process.env.AGENT_HARNESS_PROJECT_ROOT, client: {} });
      await import(${JSON.stringify(checkerUrl)});
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        AGENT_HARNESS_ROOT: root,
        AGENT_HARNESS_PROJECT_ROOT: consumerRoot,
        AGENT_HARNESS_OPENCODE_RUNTIME_CHILD: "",
      },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /agent_runtime_invocation_provenance_live_identity_ready/);
    const recordPath = resolve(consumerRoot, ".runtime/agents/runtime-invocation-provenance-live.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.repositoryRoot, consumerRoot);
    assert.equal(record.harnessRoot, root);
    assert.equal(record.pluginPath, resolve(root, ".opencode/plugins/runtime-invocation-provenance.js"));
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});


test("doctor treats codebase-memory-mcp as an MCP server, not a --version CLI", () => {
  const source = readFileSync(resolve(root, "scripts", "harness-doctor.mjs"), "utf8");
  assert.match(source, /codebaseMemoryResolved/);
  assert.match(source, /mcpHandshake: "not-run-by-doctor"/);
  assert.equal(/probe\(codebaseMemoryExecutable/.test(source), false);
});

test("source manifest is derived only from Git-tracked source and ignores local tool state", () => {
  const temp = mkdtempSync(join(tmpdir(), "agentic-harness-manifest-contract-"));
  try {
    mkdirSync(resolve(temp, ".opencode"), { recursive: true });
    mkdirSync(resolve(temp, ".serena"), { recursive: true });
    writeFileSync(resolve(temp, ".gitignore"), ".opencode/package.json\n.serena/project.local.yml\n");
    writeFileSync(resolve(temp, "source.txt"), "tracked\n");
    writeFileSync(resolve(temp, "MANIFEST.json"), "{}\n");
    writeFileSync(resolve(temp, ".opencode", "package.json"), "{}\n");
    writeFileSync(resolve(temp, ".serena", "project.local.yml"), "local: true\n");
    for (const args of [
      ["init"],
      ["add", ".gitignore", "source.txt", "MANIFEST.json"],
      ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-m", "fixture"],
    ]) {
      const result = spawnSync("git", args, { cwd: temp, encoding: "utf8", shell: false });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const script = resolve(root, "scripts", "internal", "source-manifest.mjs");
    let result = spawnSync(process.execPath, [script, "--write"], {
      cwd: temp,
      env: { ...process.env, AGENT_HARNESS_ROOT: temp },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(readFileSync(resolve(temp, "MANIFEST.json"), "utf8"));
    assert.equal(manifest.sourceAuthority, "git-tracked-worktree");
    assert.deepEqual(manifest.files.map((entry) => entry.path), [".gitignore", "source.txt"]);
    assert.equal(manifest.files.some((entry) => entry.path.includes(".opencode/package.json")), false);
    assert.equal(manifest.files.some((entry) => entry.path.includes(".serena/project.local.yml")), false);

    result = spawnSync("git", ["add", "MANIFEST.json"], { cwd: temp, encoding: "utf8", shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = spawnSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-m", "manifest"], { cwd: temp, encoding: "utf8", shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = spawnSync(process.execPath, [script, "--check"], {
      cwd: temp,
      env: { ...process.env, AGENT_HARNESS_ROOT: temp },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /agent_harness_manifest_matches_git_source/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});


test("Git checkout normalization preserves cross-platform source fingerprints", () => {
  const attributes = readFileSync(resolve(root, ".gitattributes"), "utf8");
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.zip binary$/m);
});
