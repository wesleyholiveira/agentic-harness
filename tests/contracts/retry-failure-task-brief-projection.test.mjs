import test from "node:test";
import assert from "node:assert/strict";
import { retryFailureInvariants } from "../../.agents/runtime/context-builder.mjs";

test("first semantic attempt has no retry-failure invariants", () => {
  assert.deepEqual(retryFailureInvariants({
    attempt: 1,
    priorFailureCode: null,
    priorFailureMessage: null,
  }), []);
});

test("retry projects the exact prior completion failure as explicit Task Brief authority", () => {
  const failedCommand = `required_validation_not_passed:node -e "const fs=require('fs'); const s=fs.readFileSync('test/format-name.test.mjs','utf8'); if (!s.includes('node:test') || !s.includes('Wesley') || !s.includes('Anonymous')) process.exit(1)"`;
  const invariants = retryFailureInvariants({
    attempt: 2,
    priorFailureCode: "completion_validation_failed",
    priorFailureMessage: failedCommand,
  });

  assert.ok(invariants.some((value) => value.includes("Retry corrective attempt 2")));
  assert.ok(invariants.some((value) => value.includes("Previous failure code: completion_validation_failed")));
  assert.ok(invariants.some((value) => value.includes(failedCommand)));
  assert.ok(invariants.some((value) => value.includes("do not assume edits from the failed workspace survived integration")));
  assert.ok(invariants.some((value) => value.includes("preserve already-required behavior/tests")));
  assert.ok(invariants.some((value) => value.includes("validation command named by the previous failure diagnostic must pass exactly")));
});

test("retry diagnostic is compacted and bounded", () => {
  const invariants = retryFailureInvariants({
    attempt: 3,
    priorFailureCode: "completion_validation_failed",
    priorFailureMessage: "line one\n\nline two\t" + "x".repeat(5_000),
  });
  const diagnostic = invariants.find((value) => value.startsWith("Previous failure diagnostic:"));
  assert.ok(diagnostic);
  assert.doesNotMatch(diagnostic, /\n|\t/u);
  assert.ok(diagnostic.length < 4_100);
});
