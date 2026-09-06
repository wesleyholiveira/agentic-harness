# ADR 0009 — Persistent Main Orchestrator Runtime ingress boundary

Status: Accepted

## Context

A standalone target-host qualification reached the first real consumer workload at R-7 and observed the qualified Main Orchestrator editing the consumer directly and returning an assistant handoff without invoking Context Engine `agent_start`. No Runtime provenance registration or `runId` was created.

OpenCode permits tools by default unless permissions restrict them. The standalone Main Orchestrator configuration denied built-in task delegation selectively but did not deny edit/write/patch or shell execution, and its prompt did not state a hard control-plane-only boundary. That left a bypass around Runtime V2.

## Decision

1. The persistent `main-orchestrator` is control-plane only.
2. Every delivery/change workload must enter Runtime V2 through Context Engine `agent_start`.
3. The Main Orchestrator OpenCode permissions deny:
   - `edit` (therefore `write`, `edit`, and `apply_patch`);
   - `bash`;
   - built-in `task`;
   - all `serena_*` tools as an alternate implementation path.
4. Runtime-dispatched OpenCode child specialists remain exempt from the host fence via `AGENT_HARNESS_OPENCODE_RUNTIME_CHILD=1`.
5. The provenance plugin independently rejects persistent-host attempts to invoke `write`, `edit`, `apply_patch`, `bash`, `task`, or `serena_*`, even if config permissions drift.
6. Read-only inspection remains available for non-change questions and clarification, but may not substitute for Runtime ingress.
7. If `agent_start` is unavailable or rejected, the Main Orchestrator fails closed instead of implementing directly.
8. Contract tests must prove both generated permission policy and plugin enforcement, including the runtime-child exemption.

## Consequences

The first real implementation action is forced through the Runtime control plane, making provenance registration and `runId` creation unavoidable for delivery work. The persistent outer session can still observe Runtime state and receive Durable Continuations, while specialist execution retains the tools needed to implement and validate changes.
