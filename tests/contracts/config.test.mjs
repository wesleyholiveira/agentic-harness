import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveComposeProjectName, resolveComposeProjectIdentity } from "../../scripts/internal/compose-project-identity.mjs";
import { resolveHarnessProjectRoot } from "../../scripts/internal/project-root-resolution.mjs";
import { prepareAgentInputManifest } from "../../.agents/runtime/agent-input-preparation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fsPathIdentity(value) {
  const canonical = typeof realpathSync.native === "function"
    ? realpathSync.native(resolve(value))
    : realpathSync(resolve(value));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

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

test("persistent Main Orchestrator cannot bypass Runtime V2 with direct execution tools", () => {
  const agents = JSON.parse(readFileSync(resolve(root, ".opencode", "agents.generated.json"), "utf8"));
  const main = agents["main-orchestrator"];
  assert.equal(main.permission.edit, "deny");
  assert.equal(main.permission.bash, "deny");
  assert.deepEqual(main.permission.task, { "*": "deny" });
  assert.equal(main.permission["serena_*"], "deny");
  assert.deepEqual(main.permission.skill, { "*": "allow" });

  const prompt = readFileSync(resolve(root, ".agents", "agents", "main-orchestrator", "AGENT.md"), "utf8");
  assert.match(prompt, /control-plane agent, not an implementation agent/);
  assert.match(prompt, /Context Engine MCP `agent_start`/);
  assert.match(prompt, /local OpenCode `runtime-continuation` custom tool/);
  assert.match(prompt, /pass the captured `continuation` object in the same call/);
  assert.match(prompt, /Never fall back to direct implementation/);

  const plugin = readFileSync(resolve(root, ".opencode", "plugins", "runtime-invocation-provenance.js"), "utf8");
  assert.match(plugin, /MAIN_ORCHESTRATOR_DIRECT_EXECUTION_TOOLS/);
  assert.match(plugin, /agent_runtime_main_orchestrator_direct_execution_denied/);
  assert.match(plugin, /AGENT_HARNESS_OPENCODE_RUNTIME_CHILD === "1"/);

  const consumerRoot = mkdtempSync(join(tmpdir(), "agentic-harness-main-boundary-consumer-"));
  try {
    const pluginUrl = pathToFileURL(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js")).href;
    const deniedScript = `
      const { RuntimeInvocationProvenance } = await import(${JSON.stringify(pluginUrl)});
      const hooks = await RuntimeInvocationProvenance({ serverUrl: new URL("http://127.0.0.1:4096"), directory: process.env.AGENT_HARNESS_PROJECT_ROOT, client: {} });
      for (const tool of ["write", "edit", "apply_patch", "bash", "task", "serena_replace_symbol_body"]) {
        let denied = false;
        try {
          await hooks["tool.execute.before"]({ tool, sessionID: "session-1", callID: "call-1" }, { args: {} });
        } catch (error) {
          denied = String(error?.message ?? error).includes("agent_runtime_main_orchestrator_direct_execution_denied");
        }
        if (!denied) throw new Error("direct_execution_not_denied:" + tool);
      }
    `;
    let result = spawnSync(process.execPath, ["--input-type=module", "-e", deniedScript], {
      cwd: consumerRoot,
      env: { ...process.env, AGENT_HARNESS_ROOT: root, AGENT_HARNESS_PROJECT_ROOT: consumerRoot, AGENT_HARNESS_OPENCODE_RUNTIME_CHILD: "" },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const childScript = `
      const { RuntimeInvocationProvenance } = await import(${JSON.stringify(pluginUrl)});
      const hooks = await RuntimeInvocationProvenance({ serverUrl: new URL("http://127.0.0.1:4096"), directory: process.env.AGENT_HARNESS_PROJECT_ROOT, client: {} });
      await hooks["tool.execute.before"]({ tool: "edit", sessionID: "session-1", callID: "call-1" }, { args: {} });
    `;
    result = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: consumerRoot,
      env: { ...process.env, AGENT_HARNESS_ROOT: root, AGENT_HARNESS_PROJECT_ROOT: consumerRoot, AGENT_HARNESS_OPENCODE_RUNTIME_CHILD: "1" },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});

test("host and consuming-project roots are distinct runtime concepts", () => {
  const server = readFileSync(resolve(root, "apps/context-engine/src/server.ts"), "utf8");
  const control = readFileSync(resolve(root, ".agents/runtime/control-plane.mjs"), "utf8");
  assert.match(server, /AGENT_HARNESS_PROJECT_ROOT/);
  assert.match(server, /AGENT_HARNESS_ROOT/);
  assert.match(control, /harnessRoot/);
  assert.match(control, /repositoryRoot/);
});




test("consumer launcher ignores a stale inherited project root that points to another harness checkout", () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), "agentic-harness-stale-root-consumer-"));
  const harnessRoot = resolve(consumerRoot, ".harness");
  const staleOuterHarnessRoot = mkdtempSync(join(tmpdir(), "agentic-harness-stale-outer-checkout-"));
  try {
    mkdirSync(resolve(consumerRoot, ".git"), { recursive: true });
    mkdirSync(resolve(harnessRoot, "bin"), { recursive: true });
    mkdirSync(resolve(harnessRoot, "scripts", "internal"), { recursive: true });
    mkdirSync(resolve(staleOuterHarnessRoot, "bin"), { recursive: true });
    mkdirSync(resolve(staleOuterHarnessRoot, ".agents"), { recursive: true });
    writeFileSync(resolve(staleOuterHarnessRoot, "package.json"), '{"name":"agentic-harness"}\n');
    writeFileSync(resolve(staleOuterHarnessRoot, "SOURCE-OF-TRUTH.md"), "fixture\n");
    writeFileSync(resolve(staleOuterHarnessRoot, "bin", "harness.mjs"), "// fixture\n");
    writeFileSync(resolve(staleOuterHarnessRoot, ".agents", "workflow.json"), "{}\n");

    const resolution = resolveHarnessProjectRoot({
      harnessRoot,
      cwd: consumerRoot,
      environment: { AGENT_HARNESS_PROJECT_ROOT: staleOuterHarnessRoot },
    });
    assert.equal(fsPathIdentity(resolution.projectRoot), fsPathIdentity(consumerRoot));
    assert.equal(resolution.source, "consumer-cwd-over-stale-harness-env");
    assert.equal(resolution.staleInheritedHarnessRootIgnored, true);

    for (const relativePath of [
      "bin/harness.mjs",
      "scripts/harness-bootstrap.mjs",
      "scripts/internal/compose-project-identity.mjs",
      "scripts/internal/project-root-resolution.mjs",
    ]) {
      const target = resolve(harnessRoot, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(root, relativePath), target);
    }

    const result = spawnSync(process.execPath, [resolve(harnessRoot, "bin", "harness.mjs"), "bootstrap"], {
      cwd: consumerRoot,
      env: { ...process.env, AGENT_HARNESS_PROJECT_ROOT: staleOuterHarnessRoot },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(resolve(consumerRoot, ".agent-harness", "config.json")), true);
    assert.equal(existsSync(resolve(harnessRoot, ".agent-harness")), false, "bootstrap must never write into the submodule because of a stale inherited root");
    const output = JSON.parse(result.stdout);
    assert.equal(fsPathIdentity(output.projectRoot), fsPathIdentity(consumerRoot));
    assert.equal(output.projectRootResolution.source, "consumer-cwd-over-stale-harness-env");
    assert.equal(output.projectRootResolution.staleInheritedHarnessRootIgnored, true);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
    rmSync(staleOuterHarnessRoot, { recursive: true, force: true });
  }
});

test("explicit external AGENT_HARNESS_PROJECT_ROOT remains authoritative outside the stale-self-root case", () => {
  const harnessRoot = mkdtempSync(join(tmpdir(), "agentic-harness-root-authority-"));
  const cwd = mkdtempSync(join(tmpdir(), "agentic-harness-cwd-authority-"));
  const explicitProject = mkdtempSync(join(tmpdir(), "agentic-harness-explicit-project-"));
  try {
    const resolution = resolveHarnessProjectRoot({
      harnessRoot,
      cwd,
      environment: { AGENT_HARNESS_PROJECT_ROOT: explicitProject },
    });
    assert.equal(fsPathIdentity(resolution.projectRoot), fsPathIdentity(explicitProject));
    assert.equal(resolution.source, "AGENT_HARNESS_PROJECT_ROOT");
    assert.equal(resolution.staleInheritedHarnessRootIgnored, false);
  } finally {
    rmSync(harnessRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(explicitProject, { recursive: true, force: true });
  }
});

test("Compose runtime namespace is deterministic per consumer and isolated across consumers", () => {
  const consumerA = mkdtempSync(join(tmpdir(), "agentic-harness-compose-consumer-a-"));
  const consumerB = mkdtempSync(join(tmpdir(), "agentic-harness-compose-consumer-b-"));
  try {
    const nameA1 = deriveComposeProjectName(consumerA);
    const nameA2 = deriveComposeProjectName(consumerA);
    const nameB = deriveComposeProjectName(consumerB);
    assert.equal(nameA1, nameA2);
    assert.notEqual(nameA1, nameB);
    assert.match(nameA1, /^agentic-harness-[a-f0-9]{16}$/);
    assert.equal(nameA1.includes("users"), false);
    assert.equal(nameA1.includes("tmp"), false);

    const inheritedGeneric = resolveComposeProjectIdentity(consumerA, { COMPOSE_PROJECT_NAME: "shared-global-name" });
    assert.equal(inheritedGeneric.name, nameA1, "generic COMPOSE_PROJECT_NAME must not collapse consumer isolation");
    assert.equal(inheritedGeneric.source, "derived-from-canonical-project-root");

    const explicit = resolveComposeProjectIdentity(consumerA, { AGENT_HARNESS_COMPOSE_PROJECT_NAME: "agentic-harness-explicit-fixture" });
    assert.equal(explicit.name, "agentic-harness-explicit-fixture");
    assert.equal(explicit.source, "AGENT_HARNESS_COMPOSE_PROJECT_NAME");
    assert.throws(
      () => resolveComposeProjectIdentity(consumerA, { AGENT_HARNESS_COMPOSE_PROJECT_NAME: "Invalid Project Name" }),
      /AGENT_HARNESS_COMPOSE_PROJECT_NAME/,
    );
  } finally {
    rmSync(consumerA, { recursive: true, force: true });
    rmSync(consumerB, { recursive: true, force: true });
  }
});

test("public lifecycle commands always use the consumer-scoped Compose project identity", () => {
  const launcher = readFileSync(resolve(root, "bin", "harness.mjs"), "utf8");
  const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
  assert.match(launcher, /resolveComposeProjectIdentity\(projectRoot, process\.env\)/);
  assert.match(launcher, /COMPOSE_PROJECT_NAME: composeProject\.name/);
  assert.match(launcher, /Do not leak it into/);
  assert.match(launcher, /\["compose", "-p", composeProject\.name, "-f", composeFile/);
  assert.match(launcher, /case "up": compose\(/);
  assert.match(launcher, /case "down": compose\(/);
  assert.match(launcher, /case "logs": compose\(/);
  assert.match(launcher, /case "migrate": compose\(\["--profile", "runtime", "run", "--rm", "--build", "database-migrate"\]\)/);
  assert.doesNotMatch(launcher, /case "migrate": run\(process\.execPath, \[resolve\(harnessRoot, "scripts\/harness-migrate\.mjs"\)/);
  assert.doesNotMatch(compose, /^name:\s*agentic-harness\s*$/m);
  assert.match(compose, /^\s{2}agent-harness-postgres:\s*\{\}\s*$/m);
  assert.match(compose, /^\s{2}agent-harness-rabbitmq:\s*\{\}\s*$/m);
  assert.match(compose, /^\s{2}agent-harness-redis:\s*\{\}\s*$/m);
  assert.doesNotMatch(compose, /^\s+name:\s*agent-harness-(?:postgres|rabbitmq|redis)/m);
});




test("public migrate is submodule-safe and executes the containerized migrator instead of importing host pg", () => {
  const launcher = readFileSync(resolve(root, "bin", "harness.mjs"), "utf8");
  const dockerfile = readFileSync(resolve(root, "apps", "context-engine", "Dockerfile"), "utf8");
  const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
  const migrator = readFileSync(resolve(root, "scripts", "harness-migrate.mjs"), "utf8");

  assert.match(launcher, /case "migrate": compose\(\["--profile", "runtime", "run", "--rm", "--build", "database-migrate"\]\)/);
  assert.doesNotMatch(launcher, /case "migrate": run\(process\.execPath/);
  assert.match(compose, /^  database-migrate:/m);
  assert.match(compose, /command: \["node", "scripts\/harness-migrate\.mjs"\]/);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /COPY scripts\/harness-migrate\.mjs \.\/scripts\/harness-migrate\.mjs/);
  assert.match(migrator, /import pg from "pg"/);
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
    assert.equal(config.agent["main-orchestrator"].permission.edit, "deny");
    assert.equal(config.agent["main-orchestrator"].permission.bash, "deny");
    assert.deepEqual(config.agent["main-orchestrator"].permission.task, { "*": "deny" });
    assert.equal(config.agent["main-orchestrator"].permission["serena_*"], "deny");
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


test("runtime invocation provenance follows the effective Context Engine endpoint and image source", () => {
  const plugin = readFileSync(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js"), "utf8");
  const launcher = readFileSync(resolve(root, "scripts/opencode-run.mjs"), "utf8");
  const publicLauncher = readFileSync(resolve(root, "bin/harness.mjs"), "utf8");
  const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
  const contextHttp = readFileSync(resolve(root, "apps/context-engine/src/http.ts"), "utf8");
  const dockerfile = readFileSync(resolve(root, "apps/context-engine/Dockerfile"), "utf8");

  assert.match(plugin, /AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_URL/);
  assert.match(plugin, /AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL/);
  assert.doesNotMatch(plugin, /CONTEXT_ENGINE_HTTP_PORT/);
  assert.match(launcher, /effectiveContextEngineMcpUrl/);
  assert.match(launcher, /AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_URL/);
  assert.match(launcher, /provenanceUrlFromMcp/);
  assert.match(dockerfile, /COPY \.opencode\/plugins\/runtime-invocation-provenance\.js \.\/\.opencode\/plugins\/runtime-invocation-provenance\.js/);
  assert.match(publicLauncher, /AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256/);
  assert.match(publicLauncher, /createHash\("sha256"\)/);
  assert.match(compose, /AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256/);
  assert.match(plugin, /runtime_invocation_provenance_plugin_source_env_mismatch/);
  assert.match(plugin, /expectedPluginSourceSha256/);
  assert.match(contextHttp, /host-projected-and-bundle-verified/);
  assert.match(contextHttp, /runtime_invocation_provenance_container_source_mismatch/);
  assert.match(contextHttp, /\/runtime-invocation-provenance\/identity/);

  const consumerRoot = mkdtempSync(join(tmpdir(), "agentic-harness-provenance-port-consumer-"));
  try {
    const pluginUrl = pathToFileURL(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js")).href;
    const script = `
      const calls = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        calls.push(url.toString());
        if (url.port === "4096" && url.pathname.includes("/session/")) {
          return new Response(JSON.stringify([{ info: { id: "msg-user-1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "qualify" }] }]), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.port === "28789" && url.pathname === "/runtime-invocation-provenance") {
          return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: "unexpected", url: url.toString() }), { status: 599, headers: { "content-type": "application/json" } });
      };
      const { RuntimeInvocationProvenance } = await import(${JSON.stringify(pluginUrl)});
      const hooks = await RuntimeInvocationProvenance({ serverUrl: new URL("http://127.0.0.1:4096"), directory: process.env.AGENT_HARNESS_PROJECT_ROOT, client: {} });
      await hooks["tool.execute.before"]({ tool: "agent_start", sessionID: "session-1", callID: "call-1" }, { args: { request: "fixture" } });
      console.log(JSON.stringify(calls));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        AGENT_HARNESS_ROOT: root,
        AGENT_HARNESS_PROJECT_ROOT: consumerRoot,
        AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL: "http://127.0.0.1:28789/mcp",
        AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_URL: "",
      },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /127\.0\.0\.1:28789\/runtime-invocation-provenance/);
    assert.doesNotMatch(result.stdout, /127\.0\.0\.1:8789\/runtime-invocation-provenance/);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});

test("provenance 409 reports exact expected received and bundled source identities", () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), "agentic-harness-provenance-mismatch-consumer-"));
  try {
    const pluginUrl = pathToFileURL(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js")).href;
    const pluginSha = `sha256:${createHash("sha256").update(readFileSync(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js"))).digest("hex")}`;
    const script = `
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.port === "4096" && url.pathname.includes("/session/")) {
          return new Response(JSON.stringify([{ info: { id: "msg-user-1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "qualify" }] }]), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.port === "28789" && url.pathname === "/runtime-invocation-provenance") {
          return new Response(JSON.stringify({
            error: "runtime_invocation_provenance_plugin_source_mismatch",
            expectedPluginSourceSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            receivedPluginSourceSha256: ${JSON.stringify(pluginSha)},
            bundledPluginSourceSha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          }), { status: 409, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 599, headers: { "content-type": "application/json" } });
      };
      const { RuntimeInvocationProvenance } = await import(${JSON.stringify(pluginUrl)});
      const hooks = await RuntimeInvocationProvenance({ serverUrl: new URL("http://127.0.0.1:4096"), directory: process.env.AGENT_HARNESS_PROJECT_ROOT, client: {} });
      await hooks["tool.execute.before"]({ tool: "agent_start", sessionID: "session-1", callID: "call-1" }, { args: { request: "fixture" } });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        AGENT_HARNESS_ROOT: root,
        AGENT_HARNESS_PROJECT_ROOT: consumerRoot,
        AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL: "http://127.0.0.1:28789/mcp",
        AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_URL: "",
        AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_PLUGIN_SHA256: pluginSha,
      },
      encoding: "utf8",
      shell: false,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime_invocation_provenance_http:409/);
    assert.match(result.stderr, /expected=sha256:aaaaaaaa/);
    assert.match(result.stderr, /received=sha256:/);
    assert.match(result.stderr, /bundled=sha256:bbbbbbbb/);
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
  assert.match(checker, /realpathSync\.native/);
  assert.match(checker, /process\.platform === "win32"/);
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
    assert.equal(fsPathIdentity(record.repositoryRoot), fsPathIdentity(consumerRoot));
    assert.equal(fsPathIdentity(record.harnessRoot), fsPathIdentity(root));
    assert.equal(fsPathIdentity(record.pluginPath), fsPathIdentity(resolve(root, ".opencode/plugins/runtime-invocation-provenance.js")));
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


test("standalone Agent Input Manifest reads harness-owned schemas from harnessRoot", async () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), "agentic-harness-dual-root-input-"));
  try {
    const taskDirectory = resolve(consumerRoot, ".runtime", "agents", "runs", "run-dual-root", "tasks", "technical-refinement");
    mkdirSync(taskDirectory, { recursive: true });
    const briefPath = resolve(taskDirectory, "task-brief.json");
    const contextPath = resolve(taskDirectory, "context-packet.json");
    writeFileSync(briefPath, JSON.stringify({
      taskId: "run-dual-root:technical-refinement",
      acceptanceCriteria: [],
      sdd: { stage: "technical-refinement" },
    }));
    writeFileSync(contextPath, JSON.stringify({ contractVersion: "fixture" }));

    const { manifest } = await prepareAgentInputManifest({
      repositoryRoot: consumerRoot,
      harnessRoot: root,
      taskDirectory,
      runId: "run-dual-root",
      taskId: "run-dual-root:technical-refinement",
      agentId: "technical-lead",
      attempt: 1,
      stage: "technical-refinement",
      brief: {
        taskId: "run-dual-root:technical-refinement",
        acceptanceCriteria: [],
        sdd: { stage: "technical-refinement" },
      },
      briefPath,
      contextPath,
      registry: { agents: [] },
      schemas: { agentInputManifest: null },
    });

    assert.equal(existsSync(resolve(consumerRoot, ".agents")), false, "consumer fixture must not contain a copied harness .agents tree");
    const handoff = manifest.entries.find((entry) => entry.sourceRef === "schema:handoff-result");
    const implementation = manifest.entries.find((entry) => entry.sourceRef === "schema:implementation-plan");
    assert.ok(handoff, "handoff schema must be attached");
    assert.ok(implementation, "implementation-plan schema must be attached for Technical Refinement");
    assert.equal(handoff.path.replaceAll("\\\\", "/"), resolve(root, ".agents", "schemas", "handoff-result.schema.json").replaceAll("\\\\", "/"));
    assert.equal(implementation.path.replaceAll("\\\\", "/"), resolve(root, ".agents", "schemas", "implementation-plan.schema.json").replaceAll("\\\\", "/"));
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});

test("OpenCode Runtime child resolves harness-owned schemas from AGENT_HARNESS_ROOT", () => {
  const executor = readFileSync(resolve(root, "scripts/internal/opencode-task-executor.mjs"), "utf8");
  assert.match(executor, /const harnessRoot = resolve\(process\.env\.AGENT_HARNESS_ROOT\?\.trim\(\) \|\| repositoryRoot\)/);
  assert.match(executor, /readJson\(resolve\(harnessRoot, "\.agents", "schemas", "agent-input-manifest\.schema\.json"\)\)/);
  assert.equal((executor.match(/readJson\(resolve\(harnessRoot, "\.agents", "schemas", "implementation-plan\.schema\.json"\)\)/g) ?? []).length, 2);
  assert.doesNotMatch(executor, /readJson\(resolve\(repositoryRoot, "\.agents", "schemas", "agent-input-manifest\.schema\.json"\)\)/);
  assert.doesNotMatch(executor, /readJson\(resolve\(workspace, "\.agents", "schemas", "implementation-plan\.schema\.json"\)\)/);
});
