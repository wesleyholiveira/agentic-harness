import test from "node:test";
import assert from "node:assert/strict";
import {
  requiredSuperpowersForTask,
  retryFailureInvariants,
} from "../../.agents/runtime/context-builder.mjs";

const implementationAgent = {
  superpowersSkills: [
    "test-driven-development",
    "systematic-debugging",
    "requesting-code-review",
    "verification-before-completion",
  ],
};

test("source-only implementation work item does not require test-driven-development", () => {
  assert.deepEqual(
    requiredSuperpowersForTask(implementationAgent, {
      stage: "implementation",
      ownedPaths: ["src/widget.mjs"],
    }),
    [
      "systematic-debugging",
      "requesting-code-review",
      "verification-before-completion",
    ],
  );
});

test("implementation work item that owns tests keeps test-driven-development", () => {
  for (const ownedPaths of [
    ["test/widget.test.mjs"],
    ["tests/**"],
    ["src/__tests__/widget.ts"],
    ["src/widget.spec.ts"],
    ["pkg/test_widget.py"],
    ["pkg/widget_test.go"],
  ]) {
    assert.ok(
      requiredSuperpowersForTask(implementationAgent, {
        stage: "implementation",
        ownedPaths,
      }).includes("test-driven-development"),
      `expected TDD for ${ownedPaths.join(",")}`,
    );
  }
});

test("non-implementation stage preserves configured superpowers", () => {
  assert.deepEqual(
    requiredSuperpowersForTask(implementationAgent, {
      stage: "technical-refinement",
      ownedPaths: ["src/widget.mjs"],
    }),
    implementationAgent.superpowersSkills,
  );
});

test("ownership retry projects a hard prohibition for the violating path", () => {
  const invariants = retryFailureInvariants({
    attempt: 2,
    priorFailureCode: "workspace_ownership_violation",
    priorFailureMessage: "workspace_ownership_violation:test/widget.test.mjs",
  });

  assert.ok(invariants.some((value) => value.includes("previous attempt violated workspace ownership")));
  assert.ok(invariants.some((value) => value.includes("CURRENT Task Brief.ownedPaths")));
  assert.ok(invariants.some((value) => value.includes("Do not recreate, modify, delete, stage, or rename")));
  assert.ok(invariants.some((value) => value.includes("separately owned work")));
});
