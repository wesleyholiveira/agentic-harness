import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { qualificationBehaviorCommandSpecIds } from "../../.agents/runtime/qualification-behavior.mjs";

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
