# ADR 0133 — Product Discovery bootstrap envelope reconciliation and retry diagnostics

**Status:** accepted for R17.4.2 qualification

## Context

R17.4 H-9P run `run-73d6ea3c-7405-4578-9535-832e2598ec81` closed functionally but spent 40.31% of run wall time in retries. Two Product Discovery attempts failed with `product_discovery_bootstrap_assessment_invalid` after bounded repair exhaustion. The third attempt succeeded only after an auxiliary bootstrap-assessment projection. The durable retry evidence also contained two `executor_exit_nonzero` retries, but `runtime-performance/v1.retryEvidence` preserved only the generic failure code and disposition, not the already-persisted task failure message.

## Decision

1. `bootstrapReviewAssessment.requiredCapabilities` is a redundant envelope over the capabilities already named by `factRequirements`. Before spending a new full Product Discovery attempt, Runtime may deterministically reconcile that envelope by taking the union of:
   - Product-authored `requiredCapabilities`;
   - every fact consumer capability;
   - every review provider capability resolved by the canonical capability catalog.
2. The reconciliation may not invent a fact, source, evidence, rationale or unknown capability. Fact semantics continue to be validated by `normalizeBootstrapFactRequirements` and `normalizeProductDiscoveryReviewAssessment`. Any other semantic invalidity remains fail-closed and may use the existing bounded structured projection.
3. The bounded structured projection is canonicalized through the same deterministic envelope reconciliation before final semantic validation.
4. Every future `retry.true_scheduled` event records `failureMessage` and `failureCategory` in addition to `failureCode` and disposition.
5. `runtime-performance/v1` retrospectively enriches historical retry evidence by correlating `retry.true_scheduled` with the same task/attempt `task.retry_scheduled` event, which already persisted the failure message in the event-driven finalizer. This allows a closed historical run to be diagnosed without starting a new Runtime run.
6. R17.4 performance SLOs are unchanged. This ADR removes avoidable retry amplification and improves attribution; it does not reclassify or forgive retries.

## Consequences

- A Product Discovery assessment that names `review.database` as consumer and `review.architecture` as provider cannot consume a full task retry merely because `requiredCapabilities` omitted `review.architecture`.
- Unknown capabilities, invalid authoritative sources, self-dependencies, conflicting fact requirements and missing evidence remain hard failures.
- Existing closed runs can expose the original `executor_exit_nonzero` message after the R17.4.2 source is applied, provided their paired `task.retry_scheduled` event is present.
- No model-routing, scheduler, process-loss, deterministic-reuse or SLO policy changes are introduced.
