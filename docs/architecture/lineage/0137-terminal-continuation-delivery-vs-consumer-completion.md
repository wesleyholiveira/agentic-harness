# ADR 0137 — Terminal continuation delivery versus consumer completion

Status: accepted for R17.4.5 qualification candidate

Date: 2026-08-29

## Context

R17.4.4 moved the OpenCode continuation wake from `prompt_async` to the synchronous `POST /session/:id/message` endpoint and persisted explicit session prompt affinity (`agent + provider + model + variant`). The live H-9P run `run-d92729f3-b4a7-4e4c-bf20-c6f309549c4b` closed with zero retries and passed every performance SLO, but its continuation delivery remained `dispatching` with `acceptedAt=null` and `observedAt=null` while the Main Orchestrator visibly executed the resumed qualification turn.

The failure exposed two separate contract mistakes.

First, the Rust continuation worker awaited the entire synchronous HTTP response body before calling `mark_accepted`. OpenCode documents `POST /session/:id/message` as a request that waits for and streams the AI response. Therefore the response body is the resumed assistant turn itself. Waiting for EOF before recording delivery acceptance unnecessarily couples wake admission to consumer completion and holds the per-session advisory lock while the resumed assistant is working.

Second, the R17.4.1/R17.4.4 live gate required the resumed assistant to read `assistantTerminalObserved=true` for its own current continuation before producing the verdict in that same assistant turn. That is causally impossible: the execution plane can prove that assistant turn terminal only after the turn has ended. A component cannot consume a durable proof of its own future termination while it is still producing the output that must precede that termination.

## Decision

### 1. Separate delivery from consumer completion

The continuation state machine has two distinct proofs:

- **delivery acceptance** — the exact deterministic continuation user message exists in the target OpenCode session with the expected role, effect marker and prompt SHA-256. This is the authoritative `acceptedAt` boundary;
- **consumer completion audit** — a matching assistant child with `parentID=<deterministic wake message id>` reaches terminal state. This remains the authoritative `observedAt` / `assistantTerminalObserved=true` boundary.

`acceptedAt` no longer waits for the synchronous HTTP response body to reach EOF.

### 2. Supervise the synchronous transport independently

The Rust continuation consumer still uses `POST /session/:id/message` rather than `prompt_async`, because current OpenCode `prompt_async` can persist a user message without starting an idle-session assistant loop.

The synchronous HTTP request is launched in a detached, bounded transport task. The authoritative delivery path immediately performs read-after-write reconciliation against the deterministic target message while that HTTP response may still be streaming.

When the target message matches, the worker marks the delivery `accepted` and may release/requeue verification while the assistant child is still running. The HTTP stream is transport telemetry, not authority.

A missing or ambiguous target never causes an automatic repost. Existing deterministic message IDs, effect keys, inbox deduplication, ambiguity windows and manual-review behavior remain unchanged.

### 3. The current resumed turn is live delivery proof; terminality is post-turn audit

For a live qualification executed by the same Main Orchestrator session that receives the continuation wake, the current resumed assistant turn cannot be required to prove its own terminality.

The current H-9P/H-9R wake is considered live-delivered when all of the following are true:

1. the persisted continuation uses the expected session prompt affinity;
2. the deterministic wake message is materialized exactly once and `acceptedAt` is non-null;
3. the assistant is executing as the resumed turn for that wake rather than from an unrelated human prompt or polling action;
4. no continuation collision, dead-letter or ambiguity state exists.

`assistantTerminalObserved=true` remains mandatory durable audit evidence after the resumed turn terminates, but it is not a prerequisite that the same still-running turn must consume before it can finish.

For sequential H-9P → H-9R qualification, the H-9R resumed turn must be able to observe the terminal audit of the earlier H-9P continuation. This provides a one-turn-lag live proof without self-reference. The final H-9R wake uses the same accepted/current-turn proof; its terminal audit is post-report evidence rather than a self-referential promotion prerequisite.

### 4. Preserve fail-closed behavior

This ADR does not weaken the following invariants:

- a user wake message by itself is insufficient if no resumed assistant turn occurs;
- a mismatched role/effect/prompt hash is dead, not accepted;
- transport ambiguity never authorizes automatic repost;
- explicit assistant error remains ambiguous/manual-review immediately;
- after the deterministic wake is accepted, absent/non-terminal assistant projection remains `accepted` and is rechecked until the bounded assistant-completion timeout; an `idle` session-status sample alone is not terminality authority;
- process-loss, fencing and exact effect identities remain unchanged;
- H-9R remains blocked until H-9P runtime correctness and performance are proven.

## Consequences

The continuation worker no longer stays `dispatching` merely because the resumed assistant response stream is still open. The qualification contract no longer asks the Main Orchestrator to prove that its own current turn has already terminated.

The completion audit is also projection-race tolerant: after `acceptedAt`, only a terminal assistant child proves `observedAt`; a missing/non-terminal child is retried within the bounded completion window even when `/session/status` transiently reports `idle`.

The terminal audit is still persisted and remains useful for post-turn diagnostics, cleanup and subsequent qualification turns. It is deliberately separated from the live delivery decision.

## Rejected alternatives

### Return to `prompt_async`

Rejected because the idle-session scheduling failure remains possible and would reintroduce user-message-only wakes.

### Treat HTTP 2xx as acceptance

Rejected because the external endpoint can acknowledge or begin a stream without proving the exact deterministic wake was persisted. Session history remains the authority.

### Keep terminal completion as a same-turn gate

Rejected because it is temporally impossible for the still-running assistant turn to observe proof of its own completed state.

### Automatically repost when the synchronous stream does not finish

Rejected because duplicate-prevention has priority over availability. The deterministic target is reconciled first; ambiguous outcomes remain manual-review.

## R17.4.5 parked-session clarification

`session_busy` remains a pre-dispatch fail-closed boundary. The Durable Continuation worker must not "fix" a parked controller by ignoring OpenCode `busy` and posting the deterministic wake anyway: OpenCode can persist/queue a user message before its runner admits a new turn, so bypassing the guard would weaken current-turn proof and could interfere with genuine work.

The controller side must instead make the H-9P resumed assistant terminate normally. After the second `agent_start`, the provenance plugin fences additional same-turn tools and the assistant returns `PARKED_FOR_H9R_CONTINUATION`; it does not call `/session/:id/abort`. Once the assistant naturally completes, the session becomes eligible for the existing Rust sequence `get_target_message -> session busy preflight -> mark_dispatching -> spawn_terminal_prompt -> verify_after_dispatch -> mark_accepted`.

