# ADR 0127 — Runtime V2 retry attribution and performance amplification

**Status:** proposed / R17.4 qualification required  
**Date:** 2026-08-29  
**Scope:** Runtime V2 R17 performance qualification

## Context

R17.3 finally executed the normal H-9P workload to terminal `closed` with all raw wall-clock SLOs comfortably inside their limits. The run was nevertheless held because the R17 performance contract treated every semantic attempt greater than one as an equivalent performance failure (`retryAttemptCount > 0`).

That rule was intentionally conservative while R17 was still exposing structural defects, but it does not match the retry semantics already established by ADR 0095. A second attempt can be caused by materially different conditions: a transient provider/transport/runtime failure, an exhausted deterministic repair, an unclassified policy gap, or a bounded semantic recovery from a model output that was not proven on its first attempt.

For the question R17 is intended to answer — whether the harness is operationally fast enough — those causes cannot be collapsed into one integer. A semantic recovery that remains within the run/task wall-clock budget is not equivalent to an unhealthy worker, provider outage, or exhausted repair path. Conversely, simply allowing one raw retry would weaken fail-closed qualification because an infrastructure retry could be hidden behind the same count.

## Decision

`runtime-performance/v1` remains backward compatible and keeps `execution.retryAttemptCount` as a physical-attempt diagnostic. R17.4 adds qualification authority derived from durable `retry.true_scheduled` evidence:

- `retryScheduledCount`;
- `semanticRetryCount` (`true-retry-semantic`);
- `transientRetryCount` (`true-retry-transient`);
- `repairExhaustedRetryCount` (`true-retry-repair-exhausted` or `repairExhausted=true`);
- `unclassifiedRetryCount`;
- `maxAttemptsPerTask`;
- `retryWallMs` and `retryWallShareOfRun`;
- exact retry evidence with task, source attempt, failure code, disposition and delay.

The normal H-9P performance gate requires:

- transient retries = 0;
- repair-exhausted retries = 0;
- unclassified retries = 0;
- semantic retries <= 1;
- max attempts per task <= 2;
- retry-attempt wall time <= 25% of total run wall time.

All retry attempts remain fully included in task wall-clock, critical-path and run-wall measurements. Nothing is subtracted from performance accounting.

A bounded `true-retry-semantic` recovery therefore does not by itself invalidate correctness or performance. It is accepted only when final QA/Product Acceptance evidence is proven and every other SLO passes. A second semantic retry, a third task attempt, excessive retry amplification, any transient retry, any exhausted repair retry or missing/unknown disposition forces HOLD.

## Why this is stricter than “allow one retry”

The decision does not key qualification on `attempt == 2`. It keys it on the policy decision already persisted by the Runtime. If the retry was caused by `provider_unavailable`, `network_error`, `executor_timeout`, `worker_unavailable`, repair exhaustion or a missing classification, the qualification still fails even when it recovered and the final run is `closed`.

This preserves the ability of qualification to detect an unhealthy harness while avoiding a stochastic first-pass-success requirement that is unrelated to the measured wall-clock objective.

## Consequences

- R17.3 evidence remains HOLD under its own contract and is not retroactively promoted.
- A fresh R17.4 chain is required because performance source and qualification authority changed.
- The next H-9P report must state the exact Product Discovery retry `failureCode` and `retryDisposition`; a raw count is insufficient.
- If the R17.3 Product Discovery retry was semantic and the R17.4 run reproduces at most one such recovery inside the 25% amplification cap, H-9P may proceed to H-9R.
- If it was transient, repair-exhausted or unclassified, R17.4 will remain HOLD and the causal failure must be fixed instead of changing SLOs.
