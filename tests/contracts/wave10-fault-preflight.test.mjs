import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ProcessRunner } from "../../scripts/qualification/lib/process.mjs";
import { gatewayFaultClientScript } from "../../scripts/qualification/wave10-fault-preflight.mjs";

test("fault preflight client is external to the gateway and distinguishes HTTP from transport failure", () => {
  const script = gatewayFaultClientScript();
  assert.match(script, /http:\/\/docker-behavior-gateway:8792\/v1\/behavior/u);
  assert.match(script, /kind:'http'/u);
  assert.match(script, /kind:'transport'/u);
  assert.match(script, /process\.exitCode=2/u);
  assert.doesNotMatch(script, /capability-[a-f0-9]/u);
});

test("fault preflight owns fence replacement, PostgreSQL outage, gateway outage and recovery scenarios", () => {
  const source = readFileSync(resolve("scripts/qualification/wave10-fault-preflight.mjs"), "utf8");
  assert.match(source, /QUALIFICATION_BEHAVIOR_DELAY_COMMAND_ID/u);
  assert.match(source, /SET fencing_token=fencing_token\+1/u);
  assert.match(source, /docker_gateway_fence_identity_mismatch/u);
  assert.match(source, /\["stop", "postgres"\]/u);
  assert.match(source, /docker_gateway_capability_store_unavailable/u);
  assert.match(source, /\["start", "postgres"\]/u);
  assert.match(source, /recoveredWithoutGatewayRestart/u);
  assert.match(source, /\["stop", "docker-behavior-gateway"\]/u);
  assert.match(source, /transportFailedClosed/u);
  assert.match(source, /behaviorContainerStartedWhileGatewayDown: false/u);
  assert.match(source, /\["start", "docker-behavior-gateway"\]/u);
  assert.match(source, /receiptsAccepted: 0/u);
  assert.match(source, /behaviorContainerRemoved: true/u);
  assert.match(source, /input: JSON\.stringify\(scenario\.request\)/u);
  assert.match(source, /rawCapabilityPersistedInEvidence: false/u);
  assert.match(source, /hmacKeyPersistedInEvidence: false/u);
  assert.doesNotMatch(source, /opencode/iu);
});

test("ProcessRunner.start completion is armed before stdin can finish a fast child", async t => {
  const outputDir = mkdtempSync(join(tmpdir(), "wave10-fast-start-contract-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const runner = new ProcessRunner({ outputDir });
  const secret = "x".repeat(128);
  const started = runner.start(process.execPath, [
    "-e",
    "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('done'));",
  ], {
    label: "fast-stdin-child",
    input: secret,
  });
  const completion = await Promise.race([
    started.completion,
    new Promise((_, reject) => setTimeout(() => reject(new Error("completion-timeout")), 2000)),
  ]);
  assert.equal(completion.exitCode, 0);
  assert.equal(completion.stdout, "done");
  const log = readFileSync(started.logPath, "utf8");
  assert.ok(!log.includes(secret));
});
