# ADR 0022 — Progress-aware Durable Continuation qualification

Status: accepted for standalone v1.0.0 qualification remediation

Date: 2026-09-06

## Context

A fresh standalone qualification reached the first fully successful R-7 workload. Product Discovery, Technical Refinement, Implementation, QA and Product Acceptance all completed, the Runtime run reached `closed`, and exactly one continuation wake was materialized/published.

R-8 then waited for both `accepted_at` and `observed_at` using a fixed 600,000 ms wall-clock timeout and emitted `qualification_wait_timeout:r8-continuation-accepted-observed:600000`.

The Runtime continuation authority does not use that budget. `AGENT_HARNESS_OPENCODE_CONTINUATION_COMPLETION_TIMEOUT_MS` defaults to 900,000 ms (15 minutes) and bounds observation of the terminal assistant child after deterministic wake acceptance. A qualification observer that gives up at 10 minutes can therefore reject a still-valid Runtime delivery before the Runtime's own completion authority has expired.

The old R-8 timeout also discarded the state required to distinguish `pending/deferred`, `dispatching`, `accepted-but-assistant-pending`, `manual_review`, `ambiguous`, `dead` and `observed`.

## Decision

R-8 is progress-aware.

1. Read the effective continuation completion timeout from the running Rust worker environment. If the variable is absent, use the same 900,000 ms default compiled by `apps/runtime-worker/src/config.rs`.
2. Observe the current continuation delivery row, parent continuation status, target OpenCode session status, exact deterministic wake message count and assistant child state.
3. Never fail a healthy accepted delivery before `dispatch_started_at + effective completion timeout + bounded settle grace`.
4. Fail immediately when Runtime persists a terminal invalid disposition such as `dead`, `ambiguous`, `manual_review` or `cancelled`.
5. Require `acceptedAt <= observedAt`, exactly one deterministic wake message, one `continuation.wake_materialized` event and one `continuation.delivered` event. Assistant completion follows the Runtime's latest-parented-child rule: OpenCode may emit multiple assistant records during one tool-using turn; the latest child parented by the deterministic wake must be terminal, and the delivered event must name that exact assistant message id. See ADR 0023.
6. Emit a concise R-8 progress line to stderr every 30 seconds while preserving stdout for the final machine-readable report.
7. A qualification safety ceiling remains external procedure protection only. It is derived to be longer than both pre-acceptance observation and the Runtime completion budget; it is not the normal delivery criterion.

## Authority separation

- `acceptedAt` proves deterministic user-wake materialization.
- `observedAt` proves terminal completion of the assistant child for that exact wake.
- OpenCode `/session/status` is diagnostic telemetry, not completion authority.
- A synchronous transport response is not acceptance authority.
- A persisted terminal delivery failure is Runtime authority and fails closed immediately.

## Consequences

R-8 can no longer create a false HOLD merely because the assistant turn remains valid after ten minutes. If the delivery truly stalls or enters manual review, the report contains the exact delivery/session/assistant snapshot and `last_error` needed for the next diagnosis.

No Rust continuation semantics are changed by this ADR.

## Shared downstream use

R-10's post-outage continuation recovery previously repeated the same fixed ten-minute `acceptedAt + observedAt` wait. Because it is the same Durable Continuation state machine and the same effective worker completion authority, R-10 now uses the same progress-aware continuation observer after OpenCode recovery. Its outage-injection/deferred-delivery proof is unchanged.
