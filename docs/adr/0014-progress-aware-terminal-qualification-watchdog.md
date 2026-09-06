# ADR 0014 — Progress-aware terminal qualification watchdog

## Status

Accepted.

## Context

A live standalone qualification reached R-7 with Runtime ingress, Durable Continuation binding and provenance enforcement already proven. The qualification then waited for `agent_runs.status` to become terminal using a fixed 45-minute wall-clock timeout.

That deadline was invalid as a promotion invariant. Runtime tasks have their own persisted liveness budgets, including a one-hour hard task timeout and governance soft/stall policies. A multi-stage workflow can legitimately exceed 45 minutes while remaining healthy.

The fixed deadline also produced weak evidence: the HOLD did not preserve the `runId`, active task, stage, attempt, model, execution lease, executor heartbeat, worker heartbeat, recent Runtime events, outbox state or pending execution results.

## Decision

R-7 terminal observation is progress-aware and aligned with Runtime liveness authority.

The qualification controller now:

- polls one structured PostgreSQL observation for the run, tasks, worker, latest executor heartbeats, latest task events, recent non-heartbeat events, Runtime outbox and pending execution results;
- derives each running task's liveness policy from the same `resolveExecutionLivenessPolicy()` source used by Runtime;
- permits long-running healthy work while its own hard/soft/stall budgets remain valid;
- fails closed when Runtime leaves a task beyond its own hard, soft or stall boundary;
- fails closed on stale worker/lease authority, unclaimed queued work, stalled post-execution finalization or a scheduler with no active/future execution beyond a bounded transition grace;
- writes a concise R-7 progress checkpoint to stderr every 60 seconds while preserving final JSON on stdout;
- retains only a six-hour emergency qualification safety ceiling, which is a qualification-procedure guard rather than the normal terminal criterion;
- includes the full structured Runtime observation in any watchdog HOLD.

## Consequences

Promotion no longer fails merely because the total workflow duration crosses 45 minutes.

A future long-running R-7 HOLD is actionable: it identifies the exact Runtime liveness invariant that was violated and includes enough PostgreSQL evidence to distinguish model execution, worker loss, lease expiry, scheduler stall and post-execution/finalizer stall.

This change does not alter Runtime task budgets or execution semantics.
