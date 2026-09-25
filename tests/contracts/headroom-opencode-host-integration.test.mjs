import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HEADROOM_OPENCODE_PLUGIN_SPEC,
  buildDirectOpenCodeInvocation,
  buildHeadroomEnvironment,
} from "../../scripts/internal/headroom-opencode.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Headroom host integration pins the native OpenCode plugin to the proxy version", () => {
  assert.equal(HEADROOM_OPENCODE_PLUGIN_SPEC, "headroom-opencode@0.36.5");
  const template = readFileSync(resolve(root, "config/opencode.template.jsonc"), "utf8");
  assert.match(template, /headroom-opencode@0\.36\.5/u);
});

test("Headroom-enabled host launches OpenCode directly instead of through headroom wrap", () => {
  const env = buildHeadroomEnvironment({
    PATH: process.env.PATH ?? "",
    HEADROOM_PROXY_PORT: "18793",
  });
  const invocation = buildDirectOpenCodeInvocation(
    ["--hostname", "0.0.0.0", "--port", "14096"],
    env,
  );

  assert.equal(invocation.command, "opencode");
  assert.deepEqual(invocation.args, ["--hostname", "0.0.0.0", "--port", "14096"]);
  assert.equal(invocation.env.HEADROOM_PROXY_URL, "http://127.0.0.1:18793");
  assert.equal(invocation.env.HEADROOM_ACTIVE, "1");
  assert.equal(invocation.args.includes("wrap"), false);

  const source = readFileSync(resolve(root, "scripts/internal/headroom-opencode.mjs"), "utf8");
  assert.doesNotMatch(source, /["']wrap["']\s*,\s*["']opencode["']/u);
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

test("OpenCode config generation declares Headroom plugin only for enabled persistent host", () => {
  const generator = readFileSync(resolve(root, "scripts/generate-opencode-config.mjs"), "utf8");
  assert.match(generator, /HEADROOM_OPENCODE_PLUGIN_SPEC/u);
  assert.match(generator, /AGENT_HARNESS_HEADROOM_ENABLED/u);
  assert.match(generator, /runtimeChild/u);
  assert.match(generator, /config\.plugin/u);
});
