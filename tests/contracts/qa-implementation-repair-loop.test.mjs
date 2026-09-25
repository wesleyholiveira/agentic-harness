import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyHandoffStatusFailure,
  reopenImplementationDependenciesForQaRepair,
} from "../../.agents/runtime/event-driven-finalizer.mjs";
import { latestAcceptedDependencyArtifacts } from "../../.agents/runtime/executor.mjs";
import { retryFailureInvariants } from "../../.agents/runtime/context-builder.mjs";

test("QA changes_requested is stage-classified instead of collapsed into terminal agent_blocked", () => {
  const repairable = classifyHandoffStatusFailure({
    taskPlan: { stage: "quality-assurance" },
    handoff: {
      status: "blocked",
      residualRisks: ["Explicit blank-string test is missing."],
      sddReview: {
        decision: "changes_requested",
        requiredDeltas: ['Add explicit formatName("") automated coverage.'],
      },
    },
  });
  assert.equal(repairable, null);

  const externalBlock = classifyHandoffStatusFailure({
    taskPlan: { stage: "quality-assurance" },
    handoff: {
      status: "blocked",
      residualRisks: ["Required external authority is unavailable."],
      sddReview: {
        decision: "blocked",
        requiredDeltas: ["Resolve the external authority before proceeding."],
      },
    },
  });
  assert.equal(externalBlock.code, "agent_blocked");
  assert.equal(externalBlock.retryable, false);
  assert.equal(externalBlock.blocked, true);
});

test("QA changes_requested reopens only direct implementation dependencies with remaining attempt budget", async () => {
  const runId = "run-qa-repair";
  const implementationTaskId = `${runId}:implementation:format-name`;
  const architectureTaskId = `${runId}:architecture-review`;
  const qaTaskId = `${runId}:quality-assurance`;

  const plan = {
    runId,
    tasks: [
      { taskId: implementationTaskId, stage: "implementation" },
      { taskId: architectureTaskId, stage: "architecture-review" },
      {
        taskId: qaTaskId,
        stage: "quality-assurance",
        dependencies: [architectureTaskId, implementationTaskId],
      },
    ],
  };
  const taskPlan = plan.tasks[2];
  const rows = new Map([
    [implementationTaskId, {
      task_id: implementationTaskId,
      status: "integrated",
      attempt: 1,
      max_attempts: 3,
      completed_at: "2026-09-24T23:50:32.086Z",
    }],
    [architectureTaskId, {
      task_id: architectureTaskId,
      status: "integrated",
      attempt: 1,
      max_attempts: 3,
    }],
  ]);
  const events = [];
  const store = {
    async getTask(taskId) {
      return rows.get(taskId) ?? null;
    },
    async updateTask(taskId, patch) {
      rows.set(taskId, { ...rows.get(taskId), ...patch });
    },
    async event(eventRunId, taskId, type, payload) {
      events.push({ eventRunId, taskId, type, payload });
    },
  };
  const handoff = {
    status: "complete",
    sddReview: {
      decision: "changes_requested",
      requiredDeltas: ['Add explicit formatName("") automated coverage.'],
    },
    criterionResults: [
      {
        criterionId: "AC-3",
        result: "failed",
        evidence: "Blank-string fallback is not asserted independently.",
      },
    ],
    validation: [],
    residualRisks: ["Blank-string acceptance coverage remains incomplete."],
  };

  const result = await reopenImplementationDependenciesForQaRepair({
    plan,
    taskPlan,
    store,
    handoff,
    qaAttempt: 1,
  });

  assert.deepEqual(result, {
    reopenedTaskIds: [implementationTaskId],
    exhaustedTaskIds: [],
  });

  const reopened = rows.get(implementationTaskId);
  assert.equal(reopened.status, "retrying");
  assert.equal(reopened.completed_at, null);
  assert.equal(reopened.error_code, "qa_review_changes_requested");
  assert.equal(reopened.retry_not_before, null);
  assert.match(reopened.error_message, /formatName\("\\"\\"\)/u);
  assert.match(reopened.error_message, /AC-3/u);

  assert.equal(rows.get(architectureTaskId).status, "integrated");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task.reopened_for_qa_repair");
  assert.deepEqual(events[0].payload.requiredDeltas, ['Add explicit formatName("") automated coverage.']);
});

test("QA repair does not reopen an implementation task whose attempt budget is exhausted", async () => {
  const runId = "run-qa-repair-exhausted";
  const implementationTaskId = `${runId}:implementation:format-name`;
  const qaTaskId = `${runId}:quality-assurance`;
  const plan = {
    runId,
    tasks: [
      { taskId: implementationTaskId, stage: "implementation" },
      { taskId: qaTaskId, stage: "quality-assurance", dependencies: [implementationTaskId] },
    ],
  };
  const rows = new Map([
    [implementationTaskId, {
      task_id: implementationTaskId,
      status: "integrated",
      attempt: 3,
      max_attempts: 3,
    }],
  ]);
  const events = [];
  const store = {
    async getTask(taskId) {
      return rows.get(taskId) ?? null;
    },
    async updateTask(taskId, patch) {
      rows.set(taskId, { ...rows.get(taskId), ...patch });
    },
    async event(eventRunId, taskId, type, payload) {
      events.push({ eventRunId, taskId, type, payload });
    },
  };

  const result = await reopenImplementationDependenciesForQaRepair({
    plan,
    taskPlan: plan.tasks[1],
    store,
    handoff: {
      sddReview: {
        decision: "changes_requested",
        requiredDeltas: ["Add the missing automated acceptance case."],
      },
      criterionResults: [],
      validation: [],
      residualRisks: [],
    },
    qaAttempt: 2,
  });

  assert.deepEqual(result, {
    reopenedTaskIds: [],
    exhaustedTaskIds: [implementationTaskId],
  });
  assert.equal(rows.get(implementationTaskId).status, "integrated");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "qa.repair_target_exhausted");
});

test("dependency projection keeps only the latest accepted artifact after implementation repair", () => {
  const implementationTaskId = "run-qa-repair:implementation:format-name";
  const otherTaskId = "run-qa-repair:architecture-review";
  const artifacts = [
    {
      artifact_id: "artifact-old",
      task_id: implementationTaskId,
      accepted: 1,
      created_at: "2026-09-24T23:50:32.000Z",
      path: "/tmp/handoff-attempt-1.json",
    },
    {
      artifact_id: "artifact-new",
      task_id: implementationTaskId,
      accepted: 1,
      created_at: "2026-09-24T23:55:00.000Z",
      path: "/tmp/handoff-attempt-2.json",
    },
    {
      artifact_id: "artifact-rejected",
      task_id: implementationTaskId,
      accepted: 0,
      created_at: "2026-09-24T23:56:00.000Z",
      path: "/tmp/rejected.json",
    },
    {
      artifact_id: "artifact-other",
      task_id: otherTaskId,
      accepted: 1,
      created_at: "2026-09-24T23:40:00.000Z",
      path: "/tmp/architecture.json",
    },
  ];

  const selected = latestAcceptedDependencyArtifacts(
    artifacts,
    [otherTaskId, implementationTaskId],
  );

  assert.deepEqual(
    selected.map((artifact) => artifact.artifact_id),
    ["artifact-other", "artifact-new"],
  );
});

test("QA corrective retry invariants preserve the already integrated implementation", () => {
  const invariants = retryFailureInvariants({
    attempt: 2,
    priorFailureCode: "qa_review_changes_requested",
    priorFailureMessage: 'Required deltas: Add explicit formatName("") automated coverage.',
  });
  const text = invariants.join("\n");

  assert.match(text, /preceding implementation was integrated/u);
  assert.match(text, /current authoritative workspace/u);
  assert.match(text, /CURRENT Task Brief\.ownedPaths/u);
  assert.match(text, /formatName\("\\"\\"\)/u);
  assert.doesNotMatch(text, /do not assume edits from the failed workspace survived integration/u);
});
