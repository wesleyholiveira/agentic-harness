# ADR 0132 — Terminal Continuation Assistant-Completion Proof

## Status

Accepted for R17.4.1 qualification hardening; requires fresh promotion qualification.

## Context

R17.4 H-9P run `run-73d6ea3c-7405-4578-9535-832e2598ec81` reached terminal `closed`, completed all 10 tasks and materialized exactly one Durable Continuation generation. The continuation delivery was reported as delivered/observed, yet the parked outer controller did not autonomously resume to execute `agent_summary`, `context_efficiency`, cleanup/verdict logic and emit the required qualification report. A later explicit human turn observed that the run had already completed.

The previous continuation worker considered a delivery observed as soon as the deterministic OpenCode **user message** created by `prompt_async` existed with the expected effect marker/hash. That proves only prompt persistence/acceptance. It does not prove that OpenCode started and completed the corresponding assistant turn.

This distinction is material because OpenCode `prompt_async` is fire-and-forget. The server can accept the HTTP request and persist/start asynchronous work separately; asynchronous startup/generation failures are not equivalent to transport rejection. Therefore `continuation.delivered` must not mean merely "the user wake message exists".

## Decision

1. The deterministic continuation user message remains the exactly-once external effect identity and automatic repost remains forbidden after an accepted/ambiguous dispatch.
2. A delivery is persisted as `observed` / `continuation.delivered` only after the Runtime proves a terminal OpenCode assistant response whose `parentID` equals the deterministic continuation `opencode_message_id`.
3. While that assistant response is running, has not yet appeared, or is materialized without a terminal marker, the delivery remains `accepted` and is rechecked without another prompt dispatch. OpenCode session `idle` projection is not completion authority for an already accepted deterministic wake.
4. An explicit assistant error or expiry of the bounded completion window enters `manual_review`; no automatic repost is permitted. Session-idle telemetry alone must not turn an accepted wake into ambiguity because message/terminal metadata may lag the synchronous response lifecycle.
5. `AGENT_HARNESS_OPENCODE_CONTINUATION_COMPLETION_TIMEOUT_MS` bounds assistant-completion observation independently from the short external-dispatch ambiguity window. Default: 900000 ms (15 min).
6. `continuation.delivered` records `assistantMessageId` and `assistantTerminalObserved=true` as durable proof.
7. The generic continuation prompt explicitly instructs the resumed controller to finish the parked procedure and emit the required final report/verdict. For performance/token qualifications it also directs the resumed controller to call run-scoped `context_efficiency` after `agent_summary`.
8. `agent_summary` exposes `runtime-performance/v1` and `retryEvidence`, so a terminal resumed controller can report exact retry task/failure/disposition evidence without reconstructing it from task rows.

## Invariants

- One semantic continuation effect still performs at most one automatic `prompt_async`.
- A deterministic user-message match is necessary but no longer sufficient for delivered authority.
- A missing assistant completion can never be represented as successful wake delivery.
- Assistant observation does not mutate the Runtime run/task authority.
- Main-session non-terminal progress remains sessionless and unchanged.
- H-9R process-loss semantics remain unchanged.

## Qualification consequence

R17.4 cannot be promoted from evidence generated before this source change. A fresh byte-consistent `R-0 → R-1 → R-2 → R-2P → H-8 → H-9P → H-9R` chain is required. H-9P/H-9R must prove exactly one `continuation.delivered` with terminal assistant proof and a visible resumed-controller final report. If a run is functionally closed but retry amplification violates R17.4 SLOs, the resumed report must still be produced and the verdict remains HOLD.
