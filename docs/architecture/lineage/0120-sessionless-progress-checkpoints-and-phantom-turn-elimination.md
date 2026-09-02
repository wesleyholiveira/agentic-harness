# ADR 0120 — Sessionless progress checkpoints and phantom-turn elimination

## Status

Accepted for Runtime V2 V12.6.1 R15.6.12.

## Context

Runtime V2 must keep the continuation-bound Main Orchestrator parked after `agent_start` until an explicit human turn or the terminal Durable Continuation. Earlier progress delivery persisted non-terminal presentation text into that same OpenCode session as silent/`noReply` user messages. This preserved conversation history but coupled the presentation plane to the model-loop session.

A fresh R15.6.11 H-9 showed that the server-bound hard-turn abort cancelled the original post-start turn, yet a later non-terminal progress-session append was followed by an autonomous `context_efficiency` call. Provenance correctly classified that call as `autonomous-assistant`; the Context Engine correctly denied it. The remaining defect was therefore upstream of the parked guard: non-terminal progress was still mutating the parked model session.

OpenCode has also documented phantom model turns associated with silent/noReply/ignored user messages being treated as pending loop input. Runtime V2 must not depend on host-specific silent-message semantics for presentation correctness.

## Decision

Non-terminal Runtime progress is sessionless with respect to the continuation-bound OpenCode conversation.

1. Runtime renders progress in the existing isolated reporter path or deterministic fallback.
2. Runtime commits the rendered presentation checkpoint durably through `progress.checkpoint_committed`.
3. The checkpoint records a durable `messageId`, `text`, source event/effect identity, `deliveryMode=checkpoint-readthrough`, `liveProjectionChannel=context-engine-tui-readthrough-v2`, `durablePresentationCheckpoint=true`, and `mainSessionMutated=false`.
4. Context Engine exposes the current active-run checkpoint through `/runtime-progress-live`, accepting either `runId` or the continuation-bound `sessionId`.
5. The attached TUI polls/read-throughs that Context Engine endpoint and projects the checkpoint locally.
6. The TUI continues to emit `progress.live_delivery_observed`, correlated to the durable checkpoint `messageId`, projector `instanceId`, continuation `sessionId`, and effect key.
7. While Context Engine resolves an active run for the attached session, absence of a checkpoint means "not committed yet". The TUI must not fall back to stale OpenCode history for another run.
8. OpenCode session-history parsing remains only a legacy fallback when no active Runtime run can be resolved for the attached session.
9. No non-terminal progress path may invoke `appendContext`, `session.prompt`, `prompt_async`, `POST /session/:id/message`, or equivalent main-session mutation.
10. Main-session `busy|idle` state is not a progress delivery or coalescing dependency.
11. Only the terminal Durable Continuation may intentionally re-enter the continuation-bound main session.
12. After an `agent_start` that requests `session-resume-event`, the host plugin records a graceful per-session park fence and does **not** call `/session/:id/abort`. Same-turn tool calls are fenced while the assistant returns the required terminal sentinel naturally.
13. OpenCode 1.18.25 selects the newest N rows but returns that bounded page in chronological order. The host plugin selects the newest user message by maximum `info.time.created` when available and otherwise by the **last** user entry in the returned page; it must never `reverse().find(...)` the current user turn.
14. A park fence is released only when a **different newer user message id** appears. If that newer user message is the deterministic continuation prompt, its `durable-continuation` provenance remains sticky for every subsequent tool call in that resumed assistant turn. A continuation message that is itself the current parked baseline does not release its own H-9R fence.
15. The Context Engine parked guard remains authoritative after the run becomes terminal while its continuation wake is still materialization-pending or `deferred|claimed|dispatching`. Autonomous observation is not re-enabled merely because `run.status` became terminal; it resumes only after live wake acceptance/observation or an explicit human turn.
16. Every live provenance registration must carry the SHA-256 of the plugin bytes actually loaded by the OpenCode process. Context Engine compares that SHA to the repository-bound plugin source and rejects stale/missing plugin identity. PRE-R0/H-8 additionally require a live plugin identity receipt from an alive host process; after plugin source changes the persistent OpenCode host must be restarted and a fresh TUI attached before qualification.

## Consequences

- The progress panel remains live without inserting synthetic user messages into the model conversation.
- Durable correlation remains PostgreSQL/Runtime-authoritative; TUI presentation remains non-authoritative.
- Context-pack/token metrics are no longer polluted by non-terminal progress-history messages.
- Progress delivery cannot by itself schedule a phantom assistant turn in the parked Main session.
- Legacy checkpoint messages from older Runtime revisions can still be read when no active run is resolved, easing transition without weakening active-run isolation.
- Qualification must fail if a non-terminal main-session progress mutation is observed during H-9/H-9R.

## R17.4.5 amendment: graceful park, not session abort

A parked Main Orchestrator turn must become terminal through the normal OpenCode assistant lifecycle. After the H-9R `agent_start` result requests `session-resume-event`, the host provenance plugin records a per-session park fence. While the same user message remains current, every subsequent tool invocation is rejected as autonomous parked work. The assistant must then return the single sentinel `PARKED_FOR_H9R_CONTINUATION` and terminate normally.

The plugin must not implement parking with `POST /session/:id/abort`. An abort can leave a persisted assistant child without `time.completed`/`finish` while OpenCode's in-memory session status remains `busy`. That state prevents the Durable Continuation consumer from dispatching the terminal wake because the consumer correctly fails closed before HTTP dispatch when the target session is genuinely or apparently busy.

The park fence is released only by a deterministic terminal-continuation user wake with a user message id different from the parked baseline, or by a genuinely newer explicit human user message. The deterministic wake makes `durable-continuation` provenance sticky for the whole resumed turn so H-9P `agent_summary`, `context_efficiency`, worker arming and PRE-H-9R remain legal. When the second H-9R `agent_start` re-arms the fence on that same continuation user message, the identical baseline message cannot self-release the fence. The explicit-human path preserves user agency but invalidates qualification promotion if it is used as a manual `Continue` workaround.

