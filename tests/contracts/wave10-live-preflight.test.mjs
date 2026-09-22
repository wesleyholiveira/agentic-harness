import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  QUALIFICATION_BEHAVIOR_COMMAND_ID,
  materializeFixture,
  qualificationProjectDescriptor,
} from "../../scripts/qualification/lib/fixture.mjs";
import {
  qualificationBehaviorAuthority,
} from "../../scripts/qualification/lib/source-attested-behavior.mjs";
import {
  commandAuthorityFromConfiguration,
  parseDockerRuntimeVersion,
  sqlLiteral,
} from "../../scripts/qualification/wave10-live-preflight.mjs";
import { ProcessRunner } from "../../scripts/qualification/lib/process.mjs";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("qualification behavior fixture uses a constructible source-attested one-off runner", () => {
  const descriptor = qualificationProjectDescriptor();
  const runner = descriptor.runners.find(item => item.id === "qualification-behavior");
  const command = descriptor.commands.find(item => item.id === QUALIFICATION_BEHAVIOR_COMMAND_ID);
  assert.ok(runner);
  assert.equal(runner.operation, "one-off");
  assert.equal(runner.image.mode, "source-attested-build");
  assert.equal(runner.image.reference, null);
  assert.equal(runner.buildTarget, "behavior");
  assert.ok(command);
  assert.deepEqual(command.argv, ["--test", "test/format-name.test.mjs"]);
  assert.deepEqual(command.effects, ["read-only"]);
  assert.equal(command.networkPolicy, "none");
});

test("source-attested qualification authority is derived from the committed consumer snapshot", t => {
  const root = mkdtempSync(join(tmpdir(), "wave10-preflight-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  materializeFixture(root);
  git(root, ["init"]);
  git(root, ["config", "user.name", "Wave10 Contract"]);
  git(root, ["config", "user.email", "wave10@example.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);

  const authority = qualificationBehaviorAuthority(root);
  assert.equal(authority.spec.image.mode, "source-attested-build");
  assert.equal(authority.spec.image.reference, null);
  assert.equal(authority.configuration.sourceCommit, git(root, ["rev-parse", "HEAD"]));
  assert.match(authority.configuration.sourceSnapshotSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(authority.runnerSpecDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(authority.sourceBindingDigest, /^sha256:[a-f0-9]{64}$/u);

  const commandAuthority = commandAuthorityFromConfiguration(authority.configuration);
  assert.equal(commandAuthority.sourceCommit, authority.configuration.sourceCommit);
  assert.equal(commandAuthority.sourceSnapshotSha256, authority.configuration.sourceSnapshotSha256);
  assert.equal(commandAuthority.descriptorDigest, authority.configuration.descriptorDigest);
  assert.equal(commandAuthority.policyDigest, authority.configuration.policyDigest);
});

test("wave10 preflight parses aligned Docker version output and rejects runtimes without volume-subpath support", () => {
  assert.deepEqual(parseDockerRuntimeVersion("27.5.1\t1.47\n"), {
    clientVersion: "27.5.1",
    serverApiVersion: "1.47",
  });
  assert.deepEqual(parseDockerRuntimeVersion("27.5.1              1.55\n"), {
    clientVersion: "27.5.1",
    serverApiVersion: "1.55",
  });
  assert.throws(
    () => parseDockerRuntimeVersion("20.10.24              1.41\n"),
    /wave10_preflight_docker_subpath_runtime_unsupported/,
  );
  assert.throws(
    () => parseDockerRuntimeVersion("27.5.1              1.44\n"),
    /wave10_preflight_docker_subpath_runtime_unsupported/,
  );
  assert.throws(
    () => parseDockerRuntimeVersion("27.5.1 1.55 extra\n"),
    /wave10_preflight_docker_subpath_runtime_unsupported/,
  );
});

test("ProcessRunner does not persist stdin secrets in command logs", t => {
  const outputDir = mkdtempSync(join(tmpdir(), "wave10-runner-secret-contract-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const runner = new ProcessRunner({ outputDir });
  const secret = "capability-" + "a".repeat(64);
  const result = runner.run(process.execPath, [
    "-e",
    "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(String(s.length)));",
  ], {
    label: "stdin-secret",
    input: secret,
  });
  assert.equal(result.stdout.trim(), String(secret.length));
  const log = readFileSync(result.logPath, "utf8");
  assert.ok(!log.includes(secret));
});

test("ProcessRunner.start supports secret stdin without logging it and captures concurrent output", async t => {
  const outputDir = mkdtempSync(join(tmpdir(), "wave10-runner-start-secret-contract-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const runner = new ProcessRunner({ outputDir });
  const secret = "capability-" + "b".repeat(64);
  const started = runner.start(process.execPath, [
    "-e",
    "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({length:s.length})),20));",
  ], {
    label: "async-stdin-secret",
    input: secret,
  });
  const completion = await started.completion;
  assert.equal(completion.exitCode, 0);
  assert.deepEqual(JSON.parse(completion.stdout), { length: secret.length });
  assert.equal(completion.captureOverflow, false);
  const log = readFileSync(started.logPath, "utf8");
  assert.match(log, /stdinProvided=true/u);
  assert.ok(!log.includes(secret));
});

test("wave10 preflight keeps raw capability out of argv/loggable command arguments", () => {
  const source = readFileSync(resolve("scripts/qualification/wave10-live-preflight.mjs"), "utf8");
  assert.match(source, /input:\s*JSON\.stringify\(request\)/u);
  assert.doesNotMatch(source, /args:\s*JSON\.stringify\(request\)/u);
  assert.doesNotMatch(source, /AGENT_HARNESS_DOCKER_GATEWAY_HMAC_KEY[^\n]*label:/u);
  assert.match(source, /rawCapabilityPersistedInEvidence:\s*false/u);
  assert.match(source, /hmacKeyPersistedInEvidence:\s*false/u);
  assert.equal(sqlLiteral("a'b"), "'a''b'");
});
