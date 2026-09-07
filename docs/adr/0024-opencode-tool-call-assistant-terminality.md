# ADR 0024 — OpenCode tool-call assistant steps are not Durable Continuation terminal proof

## Status

Accepted for the standalone v1.0.0 qualification candidate. Requires a fresh target-host qualification.

## Context

After ADR 0023 fixed line-safe Durable Continuation observation, a fresh target-host run passed R-7 end to end and reached R-8 with a coherent PostgreSQL/OpenCode snapshot.

The continuation delivery was already persisted as:

- `status=observed`;
- `acceptedAt < observedAt`;
- parent continuation `status=delivered`;
- exactly one deterministic wake message.

However, less than one second after `observedAt`, the same OpenCode session was still `busy` and the newest assistant record parented by the deterministic wake was non-terminal. This proves that Runtime had persisted `observedAt` before the resumed OpenCode turn actually terminated.

The cause is in `continuation_turn_state_from_messages()`. The old code treated either of these properties on the latest assistant child as terminal proof:

- non-null `time.completed`;
- any non-empty `finish` value.

That assumption is false for OpenCode tool-using turns. OpenCode 1.18.x completes each assistant *step* that requests a tool by persisting both:

- `finish="tool-calls"`;
- `time.completed=<timestamp>`.

OpenCode then continues the same user turn with another sibling assistant message whose `parentID` is still the deterministic wake id. A tool-call step can therefore be locally completed while the resumed continuation turn remains active.

## Decision

### Tool-followup finish reasons are non-terminal

Runtime classifies an assistant finish reason as requiring continuation when its normalized value is one of:

- `tool-calls`;
- `tool_calls`;
- `tool-use`;
- `tool_use`.

When the latest assistant child has one of those finish reasons, `continuation_turn_state_from_messages()` returns `Pending` even if `time.completed` is already set.

### Latest-child authority remains unchanged

Runtime still:

1. selects only assistant records whose `parentID` equals the deterministic continuation user-message id;
2. orders those records by `time.created`;
3. treats the newest child as the current projection of the resumed turn.

An older terminal-looking child can never make the continuation observed while a newer tool-call or pending child exists.

### Terminal proof remains fail-closed

After excluding tool-followup finish reasons, a latest assistant child may prove terminal completion when it has no explicit error and exposes a terminal marker (`time.completed` or a non-empty non-followup finish reason).

Explicit assistant errors remain ambiguous/manual-review authority. Missing/non-terminal assistant projection remains `accepted` and is rechecked until the existing bounded completion timeout. The deterministic user wake is never reposted after acceptance.

### Qualification must mirror Runtime semantics

The standalone continuation observer uses the same tool-followup classification for diagnostic assistant state. A `tool-calls` assistant with `time.completed` is reported `pending`, not `completed`.

R-8 remains fail-closed if PostgreSQL says the delivery is `observed` while the newest assistant child is still non-terminal. The gate is not weakened to accommodate this Runtime defect.

## Consequences

- `observedAt` again means terminal completion of the resumed continuation turn, not completion of one tool-call step.
- Multi-step OpenCode turns can contain multiple completed assistant records without being terminal.
- Exactly-once authority remains the deterministic user wake/effect identity, not assistant-record cardinality.
- No scheduler, retry, provenance, workspace, ownership, or transport semantics change.
- R-9/R-10 remain blocked until a fresh R-8 proves corrected posterior assistant audit.

## Qualification requirements

A fresh R-0 through R-8 run must prove:

1. R-7 closes normally;
2. exactly one deterministic continuation user wake is materialized;
3. `acceptedAt` is persisted after exact wake materialization;
4. intermediate `finish=tool-calls` assistant steps do not set `observedAt`;
5. `observedAt` is persisted only after the latest assistant child is terminal;
6. `continuation.delivered.assistantMessageId` equals that final latest assistant child;
7. `acceptedAt <= observedAt`;
8. R-8 passes before R-9 fault injection begins.
