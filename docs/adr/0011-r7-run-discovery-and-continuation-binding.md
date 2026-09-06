# ADR 0011 — R-7 run discovery and durable continuation binding

Status: Accepted

## Context

A fresh deterministic standalone qualification passed Q-ENTRY through R-6 and sent the normal synthetic consumer workload to the qualified OpenCode Main Orchestrator. R-7 then timed out waiting for a `runId`.

The qualification controller inferred Runtime ingress only from `agent_continuations.opencode_session_id`. That is not a valid run-creation authority because the Context Engine `agent_start` schema allows `continuation` to be omitted. A valid `agent_runs` row can therefore exist without an `agent_continuations` row.

At the same time, the persistent Main Orchestrator contract instructed the model to call `agent_start` directly, without first calling the local `runtime-continuation` custom tool. That made omission of the continuation possible even though the standalone architecture expects terminal Durable Continuation in R-8.

## Decision

1. `agent_runs` is the primary persisted authority that a Runtime run exists.
2. R-7 correlates the synthetic run using the exact fresh workload request in the fresh consumer database; `agent_continuations` is not used as the sole run-discovery mechanism.
3. R-7 separately requires the created run to become bound to the exact qualified OpenCode session before it can PASS.
4. The persistent Main Orchestrator must call `runtime-continuation` before `agent_start` and pass the returned `continuation` object in the same `agent_start` call.
5. The normal persistent-session `agent_start` result must therefore use `next=session-resume-event`; `next=agent_wait` is not the normal orchestration path.
6. R-7 timeout attribution distinguishes no `agent_start` evidence, provenance-without-run, run-without-continuation, and direct-execution bypass.
7. R-8 remains the gate that proves terminal continuation delivery/acceptance/observation semantics after the binding exists.

## Consequences

The qualification no longer confuses “no continuation row yet” with “no Runtime run.” Runtime ingress and Durable Continuation are proven as separate causal facts, while the operational Main Orchestrator contract makes the durable binding the default delivery path.
