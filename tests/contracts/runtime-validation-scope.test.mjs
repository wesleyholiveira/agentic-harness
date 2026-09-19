import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyValidationExecutionScope,
  isExecutableValidationCommand,
  validationScopeCompatibilityIssue,
} from "../../.agents/runtime/validation-command.mjs";

test(".runtime/agents validation requires authoritative-host scope", () => {
  const relative = `node -e "require('fs').readFileSync('.runtime/agents/runs/run-1/replay-capsule.json')"`;
  const absolute = `node -e "require('fs').readFileSync('/workspace/repository/.runtime/agents/runs/run-1/replay-capsule.json')"`;

  assert.equal(classifyValidationExecutionScope(relative), "authoritative-host");
  assert.equal(classifyValidationExecutionScope(absolute), "authoritative-host");
  assert.equal(
    validationScopeCompatibilityIssue({
      taskStage: "implementation",
      declaredScope: "workspace",
      command: relative,
    }),
    "validation_scope_exceeds_task:implementation:workspace:authoritative-host",
  );
});

test("ordinary repository validation remains workspace scoped", () => {
  assert.equal(classifyValidationExecutionScope("npm test -- test/format-name.test.mjs"), "workspace");
  assert.equal(classifyValidationExecutionScope("node scripts/check-report.mjs evidence/report.md"), "workspace");
  assert.equal(
    validationScopeCompatibilityIssue({
      taskStage: "implementation",
      declaredScope: "workspace",
      command: "npm test -- test/format-name.test.mjs",
    }),
    null,
  );
});

test("command-shaped Product verification prose is not executable validation authority", () => {
  assert.equal(isExecutableValidationCommand("npm test"), true);
  assert.equal(isExecutableValidationCommand("npm test -- test/format-name.test.mjs"), true);
  assert.equal(isExecutableValidationCommand("npm run test:ml"), true);
  assert.equal(isExecutableValidationCommand("npm test exits with code 0."), false);
  assert.equal(isExecutableValidationCommand("npm run check succeeds."), false);
  assert.equal(isExecutableValidationCommand("python scripts/check.py returns status 0"), false);
});
