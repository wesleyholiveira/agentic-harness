import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  qualificationBehaviorCommandSpecIds,
  qualificationCommandAuthorityFromConfiguration,
} from "../../.agents/runtime/qualification-behavior.mjs";
import { QualificationReport } from "../../scripts/qualification/lib/report.mjs";
import {
  productNamespaceOperationalPathspecs,
  productNamespaceReferenceClassification,
} from "../../scripts/qualification/lib/product-namespace-scan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = path => readFileSync(resolve(root, path), "utf8");

function qualificationEnv(overrides = {}) {
  return {
    AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_BOUNDARY: "repair-checkpoint-before-behavior",
    AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_TASK_MATCH: "technical-refinement",
    AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_ATTEMPT: "1",
    AGENT_HARNESS_RUNTIME_TEST_BEHAVIOR_COMMAND_ID: "qualification.behavior.delay",
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    taskId: "technical-lead-task",
    stage: "technical-refinement",
    agentId: "technical-lead",
    ...overrides,
  };
}

function brief(overrides = {}) {
  return {
    taskId: "technical-lead-task",
    agentId: "technical-lead",
    sdd: { stage: "technical-refinement" },
    modelRouting: { attempt: 1 },
    ...overrides,
  };
}

test("qualification behavior override is inert outside the pre-behavior process-loss boundary", () => {
  assert.deepEqual(qualificationBehaviorCommandSpecIds({
    taskPlan: task(),
    brief: brief(),
    attempt: 1,
    env: qualificationEnv({ AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_BOUNDARY: "" }),
  }), []);
  assert.deepEqual(qualificationBehaviorCommandSpecIds({
    taskPlan: task(),
    brief: brief(),
    attempt: 1,
    env: qualificationEnv({ AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_BOUNDARY: "repair-checkpoint-after-full-agent" }),
  }), []);
});

test("qualification behavior override is scoped to matching task and semantic attempt", () => {
  assert.deepEqual(qualificationBehaviorCommandSpecIds({
    taskPlan: task(),
    brief: brief(),
    attempt: 1,
    env: qualificationEnv(),
  }), ["qualification.behavior.delay"]);

  assert.deepEqual(qualificationBehaviorCommandSpecIds({
    taskPlan: task({ stage: "implementation" }),
    brief: brief({ sdd: { stage: "implementation" } }),
    attempt: 1,
    env: qualificationEnv(),
  }), []);

  assert.deepEqual(qualificationBehaviorCommandSpecIds({
    taskPlan: task(),
    brief: brief({ modelRouting: { attempt: 2 } }),
    attempt: 2,
    env: qualificationEnv(),
  }), []);
});

test("qualification behavior override fails closed on malformed command or attempt authority", () => {
  assert.throws(() => qualificationBehaviorCommandSpecIds({
    taskPlan: task(),
    brief: brief(),
    attempt: 1,
    env: qualificationEnv({ AGENT_HARNESS_RUNTIME_TEST_BEHAVIOR_COMMAND_ID: "npm test" }),
  }), /qualification_behavior_command_id_invalid/u);

  assert.throws(() => qualificationBehaviorCommandSpecIds({
    taskPlan: task(),
    brief: brief(),
    attempt: 1,
    env: qualificationEnv({ AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_ATTEMPT: "not-a-number" }),
  }), /qualification_behavior_attempt_invalid/u);
});

test("qualification command authority is derived only from trusted committed configuration", () => {
  const configuration = {
    schemaVersion: "committed-project-configuration/v1",
    sourceTrustVerified: true,
    policyTrustVerified: true,
    sourceCommit: "a".repeat(40),
    sourceSnapshotSha256: "sha256:" + "b".repeat(64),
    descriptorDigest: "sha256:" + "c".repeat(64),
    policyDigest: "sha256:" + "d".repeat(64),
    descriptor: {
      projectId: "qualification-project",
      repositoryId: "qualification-repository",
    },
  };
  assert.deepEqual(qualificationCommandAuthorityFromConfiguration(configuration), {
    schemaVersion: "command-authority/v1",
    projectId: "qualification-project",
    repositoryId: "qualification-repository",
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: configuration.sourceSnapshotSha256,
    descriptorDigest: configuration.descriptorDigest,
    policyDigest: configuration.policyDigest,
  });
  assert.throws(
    () => qualificationCommandAuthorityFromConfiguration({ ...configuration, sourceTrustVerified: false }),
    /qualification_behavior_committed_configuration_invalid/u,
  );
});

test("event preparation may derive qualification authority but fails on any pre-existing mismatch", () => {
  const preparation = source(".agents/runtime/event-driven-preparation.mjs");
  assert.match(preparation, /loadCommittedProjectConfiguration\(repositoryRoot\)/u);
  assert.match(preparation, /qualificationCommandAuthorityFromConfiguration/u);
  assert.match(preparation, /qualification_behavior_command_authority_mismatch/u);
  assert.match(preparation, /qualificationCommandSpecIds\.length > 0/u);
});

test("OpenCode process-loss checkpoint can continue to real behavior but never re-arms on resume", () => {
  const executor = source("scripts/internal/opencode-task-executor.mjs");
  assert.match(executor, /repair-checkpoint-before-behavior/u);
  assert.match(executor, /blockUntilProcessLoss:\s*boundary === "repair-checkpoint-after-full-agent"/u);
  assert.match(executor, /if \(resumeCheckpoint\) return null/u);
  const nonBlocking = executor.indexOf("if (!qualification.blockUntilProcessLoss)");
  const legacySleep = executor.indexOf("await sleep(qualification.waitMs)", nonBlocking);
  assert.ok(nonBlocking >= 0 && legacySleep > nonBlocking);
  assert.match(executor.slice(nonBlocking, legacySleep), /return true/u);
});

test("Compose projects qualification controls to descriptor preparation and worker only as blank-default controls", () => {
  const compose = source("compose.yaml");
  const contextBlock = compose.split("  context-engine:")[1]?.split("\n  docker-behavior-gateway:")[0] ?? "";
  const workerBlock = compose.split("  agent-runtime-worker:")[1]?.split("\nvolumes:")[0] ?? "";
  for (const key of [
    "AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_BOUNDARY",
    "AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_TASK_MATCH",
    "AGENT_HARNESS_RUNTIME_TEST_PROCESS_LOSS_ATTEMPT",
    "AGENT_HARNESS_RUNTIME_TEST_BEHAVIOR_COMMAND_ID",
  ]) {
    const projection = key + ": ${" + key + ":-}";
    assert.ok(contextBlock.includes(projection), `context-engine missing ${projection}`);
    assert.ok(workerBlock.includes(projection), `worker missing ${projection}`);
  }
});

test("product namespace gate excludes historical evolution evidence but still covers operational source", () => {
  const pathspecs = productNamespaceOperationalPathspecs();
  assert.ok(pathspecs.includes(":!docs/evolution/**"));
  assert.ok(pathspecs.includes(":!qualification/baseline/r17.4.5/**"));
  assert.equal(productNamespaceReferenceClassification("docs/evolution/agnostic-performance-v1/implementation/WAVE-10.md"), "historical-evolution");
  assert.equal(productNamespaceReferenceClassification("qualification/baseline/r17.4.5/report.json"), "historical-baseline");
  for (const operationalPath of [
    "docs/adr/0044-wave-scoped-qualification-source-authority.md",
    "scripts/qualification/standalone-v1.mjs",
    ".agents/runtime/event-driven-preparation.mjs",
    "apps/runtime-worker/src/agent_runtime.rs",
    "packages/project-adapters/src/trusted-config.mjs",
    "compose.yaml",
  ]) {
    assert.equal(productNamespaceReferenceClassification(operationalPath), "operational");
  }
});

test("R0 product namespace scan consumes the operational pathspec boundary", () => {
  const qualification = source("scripts/qualification/standalone-v1.mjs");
  assert.match(qualification, /productNamespaceOperationalPathspecs/u);
  assert.match(qualification, /\.\.\.productNamespaceOperationalPathspecs\(\)/u);
  assert.doesNotMatch(qualification, /"grep", "-niE"[\s\S]{0,240}":!qualification\/baseline\/r17\.4\.5\/\*\*"/u);
});

test("wave10 worker-loss scope is non-promotional and skips unrelated semantic gates", () => {
  const qualification = source("scripts/qualification/standalone-v1.mjs");
  assert.match(qualification, /qualificationScope = args\.wave10WorkerLoss \? "wave10-worker-loss" : "full-promotion"/u);
  assert.match(qualification, /promotionEligible = qualificationScope === "full-promotion"/u);
  assert.match(qualification, /--wave10-worker-loss/u);
  assert.match(qualification, /wave10WorkerLossGateOrder = \["Q-ENTRY", "PRE-R0", "R-0", "R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-9"\]/u);
  assert.doesNotMatch(
    qualification.match(/const wave10WorkerLossGateOrder = [^;]+;/u)?.[0] ?? "",
    /R-7|R-8|R-10/u,
  );
});

test("full promotion still requires MANIFEST check while scoped R0 uses live clean Git source identity", () => {
  const qualification = source("scripts/qualification/standalone-v1.mjs");
  const r0Start = qualification.indexOf("function r0()");
  const r0End = qualification.indexOf("\nasync function r1()", r0Start);
  const r0 = qualification.slice(r0Start, r0End);
  assert.match(r0, /if \(promotionEligible\)[\s\S]*source-manifest\.mjs"\), "--check"/u);
  assert.match(r0, /if \(!promotionEligible\)/u);
  assert.match(r0, /source\.sourceAuthority !== "git-tracked-worktree"/u);
  assert.match(r0, /R0_MANIFEST_STATUS = "DEFERRED_T17"/u);
  assert.match(r0, /manifest: promotionEligible \? manifestResult\.code : "DEFERRED_T17"/u);
});

test("scoped qualification report cannot masquerade as release promotion", () => {
  const report = new QualificationReport({
    runId: "scope-test",
    outputDir: "/tmp/unused",
    harnessRoot: "/workspace/harness",
    qualificationScope: "wave10-worker-loss",
    promotionEligible: false,
  });
  const data = report.toJSON();
  assert.equal(data.qualificationScope, "wave10-worker-loss");
  assert.equal(data.promotionEligible, false);
  assert.equal(data.verdict, "PASS");
});

test("R4 starts behavior gateway with runtime dependency profile enabled", () => {
  const qualification = source("scripts/qualification/standalone-v1.mjs");
  const r4Start = qualification.indexOf("async function r4()");
  const r5Start = qualification.indexOf("\nasync function r5()", r4Start);
  const r4 = qualification.slice(r4Start, r5Start);
  assert.match(
    r4,
    /"--profile", "runtime"[\s\S]*"--profile", "behavior-gateway"[\s\S]*"up", "-d", "docker-behavior-gateway"/u,
  );
  assert.doesNotMatch(
    r4,
    /composeCommand\(\["--profile", "behavior-gateway", "up", "-d", "docker-behavior-gateway"\]/u,
  );
});

test("R9 kills worker only inside a physical behavior window and proves replacement behavior", () => {
  const qualification = source("scripts/qualification/standalone-v1.mjs");
  assert.match(qualification, /QUALIFICATION_BEHAVIOR_DELAY_COMMAND_ID/u);
  assert.match(qualification, /repair-checkpoint-before-behavior/u);
  assert.match(qualification, /behavior\.gateway\.started/u);
  assert.match(qualification, /docker_gateway_behavior_passed/u);
  assert.match(qualification, /skippedFullAgentInvocation/u);
  assert.match(qualification, /r9_behavior_boundary_not_disarmed_on_context_engine/u);

  const sourceRunning = qualification.indexOf('label: "r9-source-behavior-container-running"');
  const processLoss = qualification.indexOf('label: "r9-worker-process-loss"');
  const sourceRemoved = qualification.indexOf('label: "r9-source-behavior-container-removed"');
  const leaseExpired = qualification.indexOf("const leaseExpiryForcedAt", sourceRemoved);
  const replacementResume = qualification.indexOf('label: "r9-repair-resume-receipt"', leaseExpired);
  const replacementRunning = qualification.indexOf('label: "r9-replacement-behavior-container-running"', replacementResume);
  const replacementCompleted = qualification.indexOf('label: "r9-replacement-behavior-completed"', replacementRunning);
  const replacementRemoved = qualification.indexOf('label: "r9-replacement-behavior-container-removed"', replacementCompleted);

  assert.ok(sourceRunning >= 0);
  assert.ok(processLoss > sourceRunning);
  assert.ok(sourceRemoved > processLoss);
  assert.ok(leaseExpired > sourceRemoved);
  assert.ok(replacementResume > leaseExpired);
  assert.ok(replacementRunning > replacementResume);
  assert.ok(replacementCompleted > replacementRunning);
  assert.ok(replacementRemoved > replacementCompleted);

  assert.match(qualification, /r9_gateway_restarted_during_worker_disconnect/u);
  assert.match(qualification, /r9_gateway_identity_changed_during_worker_recovery/u);
  assert.match(qualification, /receiptCount\) === 1/u);
});
