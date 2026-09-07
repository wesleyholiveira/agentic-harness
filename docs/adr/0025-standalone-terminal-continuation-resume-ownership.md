# ADR 0025 — Standalone terminal-continuation resume ownership

## Status

Accepted for standalone v1 qualification remediation after the first durable continuation reached a real 15-minute assistant-completion timeout.

## Context

The standalone harness now has a host-side deterministic Qualification Controller. The persistent Main Orchestrator is only the user-facing control plane for a consuming-project request.

The terminal continuation prompt was inherited from the earlier Runtime V2 promotion architecture where the resumed Main Orchestrator itself owned qualification work after the wake. That prompt still instructed every resumed turn to:

- finish a parked `outer-controller procedure`;
- emit its required `final report/verdict`;
- optionally continue qualification-oriented efficiency collection.

Those instructions were valid for the older H-9P/H-9R qualification topology but are not valid for an ordinary standalone consumer delivery. In standalone R-7 the original request is simply a user change request; R-8/R-9/R-10 and the promotion verdict are owned by the external deterministic controller.

A live R-8 run proved the deterministic wake was accepted exactly once, but the resumed assistant remained pending for the full 900-second completion budget and Runtime correctly moved the delivery to `ambiguous` / `manual_review`. The qualification snapshot did not retain tool-part status, so the exact pending tool/model boundary cannot be claimed from that run. The stale ownership instruction is nevertheless a source-contract defect independent of the missing inner-step telemetry.

## Decision

Terminal continuation in standalone mode uses a finite user-facing resume protocol:

1. Call `agent_summary` exactly once for the delivered run.
2. Continue the **original user conversation** from the authoritative terminal Runtime state.
3. If the run is terminal, report the final outcome to the user and end the resumed assistant turn.
4. Do not call `agent_start` again for the same completed request/run.
5. A distinct follow-up Runtime run is allowed only when the original user request explicitly requires a separate subsequent delivery operation.
6. Call `context_efficiency` only when the original user request explicitly asks for run-scoped performance/token evidence.
7. Do not call `agent_wait`, `agent_status`, or `agent_progress` merely to rediscover the already-delivered terminal event.
8. External qualification, fault injection, promotion gates, and harness verdicts remain host-controller authority.

The persistent Main Orchestrator system contract states the same rule so prompt generation and agent policy cannot drift.

## Diagnostic hardening

R-8/R-10 continuation observation now records bounded tool-call metadata for assistant children parented by the deterministic wake:

- assistant message id;
- tool name;
- call id;
- status;
- start/end timestamps;
- bounded error text.

It intentionally does **not** persist tool inputs or outputs in qualification evidence.

The progress line reports the currently active tool when one exists, otherwise the latest observed tool. This is diagnostic only and does not change acceptance/observation authority.

## Non-decisions

This ADR does not:

- increase the 900-second assistant-completion timeout;
- weaken exactly-once wake identity;
- weaken assistant-terminal proof;
- change Rust delivery state transitions;
- turn OpenCode session status into completion authority;
- allow the resumed Main Orchestrator to own R-8/R-9/R-10.

## Qualification

Contracts must prove that the generated continuation prompt:

- contains the finite user-facing protocol;
- contains no `outer-controller procedure` or required qualification `final report/verdict` instruction;
- forbids same-request re-entry through `agent_start`;
- preserves optional `context_efficiency` only for explicit user evidence requests.

The qualification observer must prove pending tool calls are visible in diagnostic snapshots without persisting their input/output payloads.
