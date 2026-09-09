# ADR 0037 — Technical Refinement plan/evidence phase boundary

Status: accepted

## Context

Technical Refinement owns the executable implementation plan. In qualification R-9, a semantically valid planning flow was rejected because the Technical Lead review asked for evidence that belongs to later stages: implementation files already created, `npm test` already executed, byte-identical post-state hashes, and final diff isolation. The bounded repair correctly improved the plan, but the same downstream-evidence requests remained as `requiredDeltas`, causing repeated `review_not_approved` failures even though physical worker-loss recovery had already been proven.

This conflates two authorities:

- Technical Refinement must prove that future implementation work is bounded, owned, acceptance-mapped, acyclic and deterministically verifiable.
- Implementation, QA/readiness, Product Acceptance and the external qualification controller must execute that work and produce post-state receipts.

## Decision

Technical Refinement approval is approval of `implementationPlan` readiness, not proof that implementation has already happened.

A Technical Refinement review or bounded re-review must not require as current-stage evidence:

- implementation files to already exist or have changed;
- work-item validation commands such as `npm test` to have already run;
- byte-identical post-state hashes or final diff-isolation receipts;
- QA/readiness/Product Acceptance receipts;
- external qualification-controller evidence.

Those future proofs are represented at Technical Refinement by the plan itself: exact owned paths, implementation-proof acceptance mappings, explicit invariants/objectives, dependencies and executable validation commands. The later stage that owns execution remains fail-closed until the corresponding receipt exists.

Qualification fixtures must keep host-owned fault/evidence checks outside Product acceptance criteria when the deterministic qualification controller already proves them. In R-9, established `formatName` hashes, post-run `npm test`, and harness/source isolation are host qualification checks rather than Product criteria.

This decision does not weaken completion evidence in Implementation, QA/readiness, Product Acceptance or external qualification. It only prevents future-stage evidence from becoming a prerequisite for approving the plan that schedules that future work.

## Consequences

- Technical Refinement can approve a valid plan before implementation begins.
- Same-attempt review repair cannot deadlock on evidence that cannot exist yet.
- R-9 remains strict: the host still proves worker-loss recovery, byte-identical established files, isolated artifacts and `npm test` after the Runtime run.
- Downstream execution stages remain responsible for real receipts; no evidence is fabricated or pre-approved.
