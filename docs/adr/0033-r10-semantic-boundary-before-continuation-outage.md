# ADR 0033 — R-10 semantic boundary before continuation outage

## Status
Accepted for the next standalone qualification candidate.

## Context
R-10 qualifies bounded dependency restart recovery plus Durable Continuation behavior while the persistent host OpenCode endpoint is unavailable. The previous R-10 workload was a README-only request. In qualification `standalone-v1-1788878563894-ab621ace4f9a`, Product Discovery integrated, but Technical Refinement exhausted its handoff-schema repair/retry budget before the run reached the continuation-outage proof. The controller then reported `r10_outage_run_not_closed`, even though the outage state machine had not yet been evaluated.

R-7 already proves normal model-facing ingress and a closed SDD run. R-9 proves a closed run across physical Rust-worker process loss. R-10 must still use a real semantic run so the terminal continuation is materialized naturally, but its fault window must not be armed until the run has crossed the planning boundary required to produce a valid implementation DAG.

## Decision
1. The synthetic consumer includes a dedicated R-10 PRD for one dependency-free code-and-test change (`formatSlug`). A README-only/no-code workload is not used for the outage gate.
2. R-10 starts its semantic run while host OpenCode is healthy and waits until Technical Refinement is `integrated`.
3. If the run or Technical Refinement fails before that boundary, R-10 remains fail-closed with `r10_pre_outage_semantic_run_failed`; the report includes bounded repair/schema diagnostics. This failure is never relabeled as continuation outage failure.
4. The controller proves no continuation delivery has materialized before arming the outage. A terminal run or pre-existing delivery before the arm is a qualification-procedure HOLD.
5. Only after the semantic boundary is proven does the controller stop host OpenCode. The terminal run must still close successfully; a later semantic/runtime failure is `r10_post_outage_run_not_closed`.
6. ADR 0030's pre-dispatch continuation proof remains unchanged: attempts stay zero, `dispatch_started_at` remains null, the recognized transport error is durably correlated with published outbox and deferred inbox state, and recovery must reach accepted/observed terminal delivery.
7. `repair.exhausted` handoff-schema events expose at most 12 schema error strings plus the error count. Qualification runtime observations project those bounded diagnostics. This is diagnostic evidence only and does not change retry, repair, schema, or completion semantics.

## Consequences
R-10 no longer conflates an unrelated planning failure with an outage failure, while it remains fail-closed for both. The actual continuation outage semantics are not weakened, and no qualification-only Runtime backdoor or synthetic terminal run is introduced. Future handoff-schema failures preserve the concrete schema vector needed for source-level diagnosis.
