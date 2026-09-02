# ADR 0136 — Terminal Continuation Session Prompt Affinity and Synchronous Wake Dispatch

**Status:** Accepted for R17.4.4 qualification candidate  
**Date:** 2026-08-29

## Context

R17.4.3 H-9P completed functionally with zero retries and passed the performance SLO, but the registered Durable Continuation remained `wake_pending`: the deterministic continuation user message was accepted while no terminal assistant child was observed.

Two OpenCode behaviors make the previous terminal transport unsafe as the sole wake mechanism:

1. injected/background prompts that omit `agent` and `model` can resolve through OpenCode's default-agent/default-model path rather than the parked session's active prompt identity;
2. `prompt_async` is fire-and-forget and can persist/accept a user message without reliably starting an assistant loop for an idle session.

A terminal continuation is not a new independent prompt. It is the continuation of the exact outer-controller turn that registered the Runtime run. Its prompt identity must be explicit and durable, and the Runtime must not depend on a fire-and-forget scheduling edge to prove that the assistant turn actually started.

## Decision

1. `agent-continuation/v2` snapshots a **session prompt identity** before the run is created:
   - `agentId`;
   - `providerId`;
   - `modelId`;
   - optional `variant`;
   - source user `messageId` when available.
2. For OpenCode, the snapshot is resolved from the newest non-continuation user message in the target session. Messages containing the Runtime continuation effect marker are excluded. Session-level agent/model metadata is only a fallback.
3. `agent_start` fails closed before run creation when the OpenCode continuation target has no resolvable explicit agent/provider/model identity.
4. PostgreSQL persists that identity on `agent_continuations`. It is immutable for the parked continuation binding and survives worker/reconciliation retries.
5. The Rust continuation worker sends `agent`, `model.providerID`, `model.modelID`, and optional `variant` explicitly in the terminal prompt.
6. The terminal transport uses OpenCode's **synchronous session message endpoint** (`POST /session/:id/message`) instead of `prompt_async`. The continuation consumer already executes out of band, so it may wait up to the bounded continuation completion timeout without blocking the Main Orchestrator.
7. The deterministic user `messageID`, pre-dispatch exact-message lookup, and post-dispatch read-after-write reconciliation preserve the ADR 0077 at-most-once semantic effect. A transport-ambiguous outcome is never automatically reposted.
8. A successful synchronous HTTP response is still not terminal authority. R17.4.1 completion proof remains mandatory: delivery requires a terminal assistant child whose `parentID` equals the deterministic wake message ID, plus an idle terminal session state.
9. A legacy continuation without the v2 prompt identity is never dispatched implicitly; it fails closed and requires operator cleanup/fresh qualification.
10. H-9R remains gated on H-9P correctness/performance PASS.

This ADR supersedes only ADR 0077's OpenCode `prompt_async` transport detail. ADR 0077's durable effect key, deterministic message identity, outbox/inbox, read-before-write proof, ambiguity handling, and no-automatic-repost rules remain authoritative.

## Consequences

- A continuation no longer depends on OpenCode's default agent/model resolution.
- A continuation no longer depends on `prompt_async` successfully scheduling a loop for an idle session.
- Prompt/provider cache identity is preserved across park/wake.
- Failed historical wake messages cannot become the authority for future registrations because continuation-marked user messages are excluded from identity resolution.
- The Rust continuation consumer may hold one HTTP request while the assistant turn runs, bounded by `AGENT_HARNESS_OPENCODE_CONTINUATION_COMPLETION_TIMEOUT_MS`; consumer concurrency remains bounded independently.
- Migration `0055_agent_runtime_continuation_prompt_identity.sql` extends continuation persistence without introducing any new Runtime storage backend.
- Existing pre-v2 continuation rows remain readable but cannot be auto-dispatched without an explicit prompt identity.

## Qualification

Fresh source requires a full byte-consistent:

`R-0 → R-1 → R-2 → R-2P → H-8 → H-9P → H-9R`

H-9P must prove:

- the persisted session prompt identity matches the parked outer-controller turn;
- terminal dispatch uses the synchronous `/session/:id/message` endpoint with the same agent/provider/model/variant identity;
- no terminal `prompt_async` dispatch occurs;
- `continuation.delivered` contains `assistantTerminalObserved=true`, a non-empty assistant message ID, and the same persisted prompt identity;
- the resumed controller emits the required final qualification report in that assistant turn.
