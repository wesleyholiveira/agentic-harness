import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workerExecutionCapabilities } from "../../.agents/runtime/worker-capabilities.mjs";
import { resolveSessionHostProbeTarget } from "../../.agents/runtime/session-host-readiness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("agent doctor execution readiness is derived from Rust worker heartbeat metadata", () => {
  const worker = {
    metadata_json: JSON.stringify({
      executionPlane: "rust",
      capabilities: {
        gitAvailable: true,
        gitVersion: "git version 2.39.5",
        opencodeAvailable: true,
        opencodeVersion: "1.18.26",
        authAvailable: true,
        authOpenaiAvailable: true,
        authPath: "/root/.local/share/opencode/auth.json",
        modelCatalogAvailable: true,
        openaiModels: ["openai/gpt-5.6-luna", "openai/gpt-5.6-luna-fast"],
        probeErrors: [],
      },
    }),
  };
  const result = workerExecutionCapabilities(worker, ["openai/gpt-5.6-luna"]);
  assert.equal(result.source, "rust-worker-heartbeat-metadata");
  assert.equal(result.available, true);
  assert.equal(result.gitAvailable, true);
  assert.equal(result.opencodeAvailable, true);
  assert.equal(result.authOpenaiAvailable, true);
  assert.equal(result.modelCatalogAvailable, true);
  assert.deepEqual(result.missingModels, []);
});

test("agent doctor does not infer worker Git/OpenCode/auth from the Context Engine container", () => {
  const source = readFileSync(resolve(root, ".agents/runtime/doctor.mjs"), "utf8");
  assert.doesNotMatch(source, /runProcess\("git", \["--version"\]\)/);
  assert.doesNotMatch(source, /probeOpenCodeReadiness\(\)/);
  assert.match(source, /workerExecutionCapabilities/);
  assert.match(source, /executionPlaneCapabilitiesAvailable/);
  const workerSource = readFileSync(resolve(root, ".agents/runtime/worker-capabilities.mjs"), "utf8");
  assert.match(workerSource, /rust-worker-heartbeat-metadata/);
});

test("container continuation probe uses delivery URL and ignores host-only loopback probe override", () => {
  const env = {
    AGENT_HARNESS_OPENCODE_CONTINUATION_URL: "http://host.docker.internal:54096",
    AGENT_HARNESS_OPENCODE_CONTINUATION_HOST_PROBE_URL: "http://127.0.0.1:54096",
  };
  const containerTarget = resolveSessionHostProbeTarget(env, { networkScope: "container" });
  assert.equal(containerTarget.probeUrl, "http://host.docker.internal:54096");
  assert.equal(containerTarget.deliveryUrl, "http://host.docker.internal:54096");
  assert.equal(containerTarget.translated, false);

  const hostTarget = resolveSessionHostProbeTarget(env, { networkScope: "host" });
  assert.equal(hostTarget.probeUrl, "http://127.0.0.1:54096");
  assert.equal(hostTarget.deliveryUrl, "http://host.docker.internal:54096");
  assert.equal(hostTarget.translated, true);
});

test("Context Engine compose environment does not receive the host-only continuation probe URL", () => {
  const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
  const contextBlock = compose.split("  context-engine:")[1]?.split("\n  agent-runtime-worker:")[0] ?? "";
  assert.doesNotMatch(contextBlock, /AGENT_HARNESS_OPENCODE_CONTINUATION_HOST_PROBE_URL/);
  assert.match(contextBlock, /AGENT_HARNESS_OPENCODE_CONTINUATION_URL/);
});


test("Rust worker heartbeat publishes execution capability evidence once per worker lifecycle", () => {
  const rust = readFileSync(resolve(root, "apps/runtime-worker/src/agent_runtime.rs"), "utf8");
  assert.match(rust, /struct WorkerCapabilities/);
  assert.match(rust, /git_available/);
  assert.match(rust, /opencode_available/);
  assert.match(rust, /auth_openai_available/);
  assert.match(rust, /model_catalog_available/);
  assert.match(rust, /"--pure", "models", "openai"/);
  assert.match(rust, /"capabilities": &capabilities/);
  assert.match(rust, /metadata_json/);
});
