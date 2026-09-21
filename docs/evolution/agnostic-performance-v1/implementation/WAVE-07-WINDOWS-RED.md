# WAVE-07 Windows RED — missing commandId in behavior fixture

Operator-provided focused test output exposed six failures in
`tests/contracts/command-spec-execution-v2.test.mjs`.

Root cause: the shared `behaviorFixture()` constructed a valid CommandSpec,
policy, workspace binding, materialization and toolchain receipt, but returned
`command` without returning `commandId: command.id`.

Production behavior admission intentionally accepts `commandId` as an explicit
input. With it missing, `evaluateCommandReadiness` correctly failed closed and
all behavior tests saw HOLD. The missing ID also explains why secret/env-specific
reasons were absent: command lookup never succeeded.

Correction:
- fixture now returns `commandId: command.id`;
- a dedicated regression test removes commandId and proves behavior admission
  remains HOLD with `command-or-runner-missing` and
  `toolchain-readiness-required`.

No production executor/admission logic was weakened or changed.

Evidence status: RED diagnosed and fixture corrected; target-host rerun required.
