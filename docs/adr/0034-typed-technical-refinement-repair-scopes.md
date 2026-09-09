# ADR 0034 — Typed Technical Refinement repair scopes

Status: accepted

## Context

Technical Refinement combines deterministic implementation-plan validation with semantic SDD review. A generic same-attempt repair previously returned a complete replacement `implementationPlan` for every `changes_requested` review. When the only deterministic defect was acceptance coverage, that broad mutation surface allowed a repair to create verification/documentation work items, change ownership, or introduce overlapping paths even though none of those changes were required.

This caused an oscillation between acceptance-coverage and ownership failures: valid implementation work already covered product criteria materially, but the repair attempted to obtain explicit criterion coverage by inventing new owned paths.

## Decision

Repairs are classified from the deterministic implementation-plan issue vector before a semantic repair is executed.

For `acceptance-coverage-only` defects (`implementation_plan_uncovered_criterion` and exact criterion-verification omissions), the model does **not** return an implementation plan. It returns only criterion-to-existing-work-item assignments. The Runtime applies those assignments deterministically to the current plan, appends an acceptance criterion's exact executable verification command when required, increments the revision once, and proves that immutable work-item structure is unchanged.

Immutable structure for this repair includes work-item count, IDs, owners, objectives, dependencies, owned paths, complexity, file estimates, contract/migration flags, execution mode, and validation execution scope. The repair cannot create/delete work items or mutate ownership/path/DAG state.

Acceptance coverage does not imply path ownership. Handoff evidence, reconciliation records, verification reports, and similar proof artifacts are not implementation `ownedPaths` unless the product contract explicitly requires the repository file itself.

Ownership-only and DAG-only issue vectors are classified separately for bounded repair routing. Mixed issue vectors remain fail-closed under the full implementation-plan validator; they are not permitted to bypass ownership, overlap, dependency, or acceptance checks.

## Consequences

- Coverage repair becomes a bounded mapping operation instead of a structural rewrite.
- Ownership and overlap validators remain unchanged and authoritative.
- Existing valid work is reused rather than duplicated solely to satisfy acceptance coverage.
- Repair telemetry records `repairMutationScope` and bounded repair evidence.
- Full task retries remain available only after bounded same-attempt repair fails.
