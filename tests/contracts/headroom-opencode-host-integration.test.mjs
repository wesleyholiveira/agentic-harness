import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HEADROOM_OPENCODE_PLUGIN_ENTRY_RELATIVE,
  HEADROOM_PROXY_PACKAGE,
  buildDirectOpenCodeInvocation,
  buildHeadroomEnvironment,
  buildHeadroomPluginPathInvocation,
  buildHeadroomProxyInvocation,
  resolveHeadroomOpenCodePluginPath,
  runOpenCodeWithHeadroom,
} from "../../scripts/internal/headroom-opencode.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function createPluginFixture() {
  const temp = mkdtempSync(resolve(tmpdir(), "agentic-harness-headroom-plugin-"));
  const pluginPath = resolve(temp, ...HEADROOM_OPENCODE_PLUGIN_ENTRY_RELATIVE.split("/"));
  mkdirSync(dirname(pluginPath), { recursive: true });
  writeFileSync(pluginPath, "export default async () => ({ tool: {} });\n", "utf8");
  return { temp, pluginPath };
}

test("Headroom host integration resolves the wheel-bundled standalone OpenCode entrypoint", () => {
  assert.equal(
    HEADROOM_OPENCODE_PLUGIN_ENTRY_RELATIVE,
    "headroom/providers/opencode/_dist/entry.opencode.js",
  );
  assert.equal(HEADROOM_PROXY_PACKAGE, "headroom-ai[proxy]==0.36.5");

  const template = readFileSync(resolve(root, "config/opencode.template.jsonc"), "utf8");
  assert.doesNotMatch(template, /headroom-opencode@/u);

  const resolver = buildHeadroomPluginPathInvocation({ PATH: process.env.PATH ?? "" }, "3.12");
  assert.equal(resolver.command, "uvx");
  assert.ok(resolver.args.includes("--isolated"));
  assert.ok(resolver.args.includes("--managed-python"));
  assert.ok(resolver.args.includes("--with"));
  assert.ok(resolver.args.includes("headroom-ai[proxy]==0.36.5"));
  assert.ok(resolver.args.includes("python"));
  assert.match(resolver.args.join(" "), /headroom_opencode_plugin_path/u);
});

test("explicit Headroom plugin path is absolute, regular and reused without alternate resolution", () => {
  const fixture = createPluginFixture();
  try {
    const resolved = resolveHeadroomOpenCodePluginPath({
      baseEnv: {
        HEADROOM_OPENCODE_PLUGIN_PATH: fixture.pluginPath,
        PATH: process.env.PATH ?? "",
      },
      pythonCandidates: [],
    });
    assert.equal(resolved.path, fixture.pluginPath.replaceAll("\\", "/"));
    assert.equal(resolved.source, "HEADROOM_OPENCODE_PLUGIN_PATH");
    assert.equal(resolved.python, null);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("Headroom-enabled host launches OpenCode directly instead of through headroom wrap", () => {
  const fixture = createPluginFixture();
  try {
    const env = buildHeadroomEnvironment({
      PATH: process.env.PATH ?? "",
      HEADROOM_PROXY_PORT: "18793",
      HEADROOM_OPENCODE_PLUGIN_PATH: fixture.pluginPath,
    });
    const invocation = buildDirectOpenCodeInvocation(
      ["--hostname", "0.0.0.0", "--port", "14096"],
      env,
    );

    assert.equal(invocation.command, "opencode");
    assert.deepEqual(invocation.args, ["--hostname", "0.0.0.0", "--port", "14096"]);
    assert.equal(invocation.env.HEADROOM_PROXY_URL, "http://127.0.0.1:18793");
    assert.equal(invocation.env.HEADROOM_ACTIVE, "1");
    assert.equal(invocation.headroomPlugin, fixture.pluginPath);
    assert.equal(invocation.args.includes("wrap"), false);

    const source = readFileSync(resolve(root, "scripts/internal/headroom-opencode.mjs"), "utf8");
    assert.doesNotMatch(source, /["']wrap["']\s*,\s*["']opencode["']/u);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("Headroom proxy keeps anonymous telemetry disabled while local stats remain qualification evidence", () => {
  const invocation = buildHeadroomProxyInvocation("18793", { PATH: process.env.PATH ?? "" }, "3.12");
  assert.equal(invocation.args.includes("--no-telemetry"), true);
  assert.equal(invocation.args.includes("--telemetry"), false);
});

test("Headroom environment keeps outer proxy chaining without leaking competing provider base URLs", () => {
  const env = buildHeadroomEnvironment({
    PATH: process.env.PATH ?? "",
    HEADROOM_PROXY_PORT: "18793",
    OPENAI_BASE_URL: "http://127.0.0.1:18787/v1",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:18788",
  });

  assert.equal(env.OPENAI_TARGET_API_URL, "http://127.0.0.1:18787/v1");
  assert.equal(env.ANTHROPIC_TARGET_API_URL, "http://127.0.0.1:18788");
  assert.equal("OPENAI_BASE_URL" in env, false);
  assert.equal("ANTHROPIC_BASE_URL" in env, false);
  assert.equal(env.HEADROOM_ACTIVE, "1");
});

test("OpenCode config generation requires an absolute bundled Headroom entry only for enabled persistent host", () => {
  const generator = readFileSync(resolve(root, "scripts/generate-opencode-config.mjs"), "utf8");
  assert.match(generator, /HEADROOM_OPENCODE_PLUGIN_PATH/u);
  assert.match(generator, /headroom_opencode_plugin_path_required/u);
  assert.match(generator, /headroom_opencode_plugin_missing/u);
  assert.match(generator, /runtimeChild/u);
  assert.match(generator, /config\.plugin/u);
  assert.doesNotMatch(generator, /HEADROOM_OPENCODE_PLUGIN_SPEC/u);
});

test("managed Headroom proxy failure is fail-closed before OpenCode launch", async () => {
  let launches = 0;
  const status = await runOpenCodeWithHeadroom(
    ["--port", "14096"],
    { PATH: process.env.PATH ?? "", HEADROOM_PROXY_PORT: "18793" },
    {
      startProxy: async () => {
        throw new Error("fixture_proxy_failed");
      },
      spawnProcess: () => {
        launches += 1;
        throw new Error("must_not_launch");
      },
      terminateProcessTree: () => {},
    },
  );

  assert.equal(status, 1);
  assert.equal(launches, 0);
});

test("direct OpenCode exit code is preserved and managed proxy is cleaned up", async () => {
  const fixture = createPluginFixture();
  try {
    const proxyChild = new EventEmitter();
    proxyChild.pid = 777;
    proxyChild.exitCode = null;
    const openCodeChild = new EventEmitter();
    openCodeChild.pid = 778;
    openCodeChild.exitCode = null;
    let terminated = 0;
    let launched;

    const baseEnv = {
      PATH: process.env.PATH ?? "",
      HEADROOM_PROXY_PORT: "18793",
      HEADROOM_OPENCODE_PLUGIN_PATH: fixture.pluginPath,
    };
    const statusPromise = runOpenCodeWithHeadroom(
      ["--hostname", "0.0.0.0", "--port", "14096"],
      baseEnv,
      {
        startProxy: async ({ baseEnv: receivedEnv, port }) => ({
          child: proxyChild,
          python: "3.12",
          port: String(port),
          env: buildHeadroomEnvironment(receivedEnv),
          invocation: { command: "uvx", args: [] },
          output: [],
        }),
        spawnProcess: (command, args, options) => {
          launched = { command, args, options };
          queueMicrotask(() => openCodeChild.emit("exit", 3221226505, null));
          return openCodeChild;
        },
        terminateProcessTree: (child) => {
          assert.equal(child, proxyChild);
          terminated += 1;
        },
      },
    );

    const status = await statusPromise;
    assert.equal(status, 3221226505);
    assert.equal(launched.command, "opencode");
    assert.deepEqual(launched.args, ["--hostname", "0.0.0.0", "--port", "14096"]);
    assert.equal(launched.options.env.HEADROOM_PROXY_URL, "http://127.0.0.1:18793");
    assert.equal(launched.options.env.HEADROOM_ACTIVE, "1");
    assert.equal(launched.options.env.HEADROOM_OPENCODE_PLUGIN_PATH, fixture.pluginPath);
    assert.equal(terminated, 1);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("standalone qualification proves bundled plugin load before proving request traffic", () => {
  const qualification = readFileSync(resolve(root, "scripts/qualification/standalone-v1.mjs"), "utf8");
  assert.match(qualification, /resolveHeadroomOpenCodePluginPath/u);
  assert.match(qualification, /buildDirectOpenCodeInvocation/u);
  assert.doesNotMatch(qualification, /buildHeadroomWrapInvocation/u);
  assert.match(qualification, /experimental\/tool\/ids/u);
  assert.match(qualification, /headroom_retrieve/u);
  assert.match(qualification, /headroom_native_plugin_not_loaded/u);
  assert.match(qualification, /\/stats/u);
  assert.match(qualification, /headroom_native_transport_traffic_unproven/u);
  assert.doesNotMatch(qualification, /HEADROOM_TELEMETRY:\s*"on"/u);
});
