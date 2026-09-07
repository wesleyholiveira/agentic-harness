# ADR 0030 — R-10 pre-dispatch continuation outage proof

- Status: Accepted
- Date: 2026-09-07
- Scope: standalone qualification R-10 only

## Context

A fresh target-host qualification on source fingerprint `sha256:9c2144881b6b6bc71ca23091e94ba17f4687bcc2db6def43c50c63c422c58a74` passed R-0 through R-9, including the physical worker-loss/replacement proof, and reached R-10. R-10 stopped the qualified OpenCode endpoint before the test run became terminal, then waited for a deferred Durable Continuation delivery.

The gate timed out at `r10-continuation-deferred` because its predicate required both `attempts > 0` and `last_error`.

That requirement contradicts Runtime continuation semantics. `agent_continuation_deliveries.attempts` is incremented only by `mark_dispatching()`, immediately before a prompt POST can be launched. With OpenCode fully unavailable, the worker first fails while reading the deterministic target message (`get_target_message()`), before `mark_dispatching()` is reachable. The correct pre-dispatch outage state therefore has:

- `attempts = 0`;
- `dispatch_started_at IS NULL`;
- no `accepted_at` or `observed_at`;
- a transport error such as `agent_continuation_target_message_get_failed`;
- the continuation outbox message published;
- the corresponding Runtime inbox record deferred for retry.

The Runtime was behaving correctly; the qualification predicate was waiting for a state that must not occur when the endpoint is actually down before dispatch.

## Decision

R-10 now treats a pre-dispatch transport deferral as the authoritative outage proof.

The controller observes one JSON-framed PostgreSQL projection joining:

1. the latest `agent_continuation_deliveries` row for the R-10 run;
2. its `agent.continuation.wake.v1` `agent_runtime_outbox` envelope by `deliveryId`;
3. the matching `agent_runtime_inbox` row by outbox/message identity.

`evaluateContinuationOutageDeferral()` succeeds only when all of the following are true:

- the delivery has not been accepted or observed;
- no prompt dispatch has begun (`attempts === 0`, `dispatchStartedAt === null`);
- the error is a recognized pre-dispatch OpenCode availability failure;
- the outbox wake was published at least once;
- the inbox is durably marked `deferred` with the same error and at least one delivery.

The gate remains fail-closed:

- `accepted`/`observed` while OpenCode is supposed to be down => `QUALIFICATION PROCEDURE`, fault window missed;
- any prompt dispatch while the endpoint is supposed to be down => `QUALIFICATION PROCEDURE`, pre-dispatch fault window missed;
- `dead`/`ambiguous` => `RUNTIME`;
- an unexpected pre-dispatch error => `RUNTIME`.

After this proof, R-10 restarts the same qualified OpenCode host and continues to use the existing progress-aware Durable Continuation observer for eventual acceptance and terminal assistant observation.

## Consequences

- No Runtime state-machine behavior changes.
- `attempts` keeps its correct meaning as external prompt-dispatch attempts rather than Rabbit/inbox processing attempts.
- R-10 now proves both halves of the intended contract: no external prompt effect while OpenCode is unavailable, followed by successful delivery after recovery.
- The deferred observation is JSON-framed and correlates delivery, outbox and inbox identities instead of relying on a transient tabular row alone.
