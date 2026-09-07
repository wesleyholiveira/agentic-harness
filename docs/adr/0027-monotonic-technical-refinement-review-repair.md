# ADR 0027 — Monotonic Technical Refinement review repair

Status: Accepted

## Context

The first fresh standalone qualification after ADR 0026 proved that the persistent Main Orchestrator now enters Runtime correctly. Q-ENTRY through R-6 passed and R-7 materialized a durable Runtime run. Product Discovery and Architecture Review integrated on their first attempts, but Technical Refinement exhausted all three task attempts and the run closed `failed` with `review_not_approved`: the final handoff still did not carry `sddReview.decision=approved`.

The event sequence showed bounded same-attempt Technical Refinement repairs executing before each true task retry, but the qualification snapshot did not retain the exact `requiredDeltas`. Source inspection exposed two independent closure defects in that repair protocol:

1. `repairImplementationPlanFromReview()` repaired only `implementationPlan` and removed `sddReview`. The subsequent generic review projector received the whole repaired Handoff and was free to discover a new `changes_requested` scope. A bounded repair could therefore move from delta A to unrelated delta B inside the same task attempt instead of monotonically closing the original review.
2. The original Handoff's `blocking:` residual risks and `required:` follow-ups survived plan repair. Generic completion/review eligibility treats those strings as open blockers. A repaired plan could therefore resolve the review delta while stale pre-repair text kept approval structurally ineligible unless that text was also semantically reconciled.

The existing executor also had a failure edge: because plan repair intentionally deletes `sddReview` before reprojection, an exception during reprojection could leak a review-less Handoff out of the same-attempt repair loop instead of preserving the prior negative review and cleanly exhausting the repair budget.

Technical Refinement additionally declared interactive Superpowers planning/worktree/review workflows even though the Runtime task contract is explicitly non-interactive and already defines `implementationPlan` as the sole machine-readable planning authority. That is a second planning authority with no value at this stage.

## Decision

1. Technical Refinement same-attempt semantic repair is a **closed review loop**. The `requiredDeltas` present when a repair pass starts are the complete repair scope for that pass.
2. After deterministic plan repair succeeds, Runtime uses a dedicated Technical Refinement repair projector rather than the generic Handoff review projector.
3. The bounded re-review may return only:
   - `approved` with `requiredDeltas=[]`; or
   - `changes_requested` with an exact subset of the incoming `requiredDeltas`.
   It cannot introduce a new delta and cannot return `blocked`. A genuinely new semantic issue belongs to a fresh full Technical Lead attempt, where the complete review scope may be reconsidered.
4. Pre-repair `blocking:` residual risks and `required:` follow-ups are explicit closure candidates. The bounded re-review may mark only exact existing strings as resolved. Runtime removes only the exact markers explicitly closed by the re-review. Any unclosed marker remains completion-blocking. There is no deterministic or model-free deletion of evidence.
5. The repair projector receives a bounded payload containing the repaired plan, original delta set, process criteria/results, validation authority/evidence, Product acceptance criteria, upstream evidence and exact closure candidates. It does not receive the full `sourceHandoff` as a fresh design/review surface.
6. The repaired plan must already pass the existing deterministic Technical Plan schema, Product-criteria, ownership, dependency and executable-validation checks before bounded re-review.
7. If the bounded reprojection itself fails, the executor restores the prior negative `sddReview` before continuing or exhausting same-attempt repair. A review-less Handoff may not escape this edge.
8. The `technical-lead` manifest declares no Superpowers skills. Technical Refinement uses harness-owned SDD/planning contracts only. `TaskBrief.sdd.requiredSuperpowers` therefore permits an explicit empty array. Runtime-child Superpowers remain available to implementation/review specialists whose stage contracts are compatible with them.
9. R-0 rejects a source candidate that reintroduces Technical Lead Superpowers for Technical Refinement.
10. Runtime repair events persist the current/remaining `requiredDeltas`, and the standalone R-7 Runtime observation exposes those fields so a future HOLD identifies the actual semantic repair scope rather than only `review_not_approved`.

## Consequences

Same-attempt Technical Refinement repair is now monotonic: each successful re-review either closes the original issue set or carries forward a subset of unresolved issues. It cannot keep a task alive by inventing a new target after every plan rewrite.

The remediation remains fail-closed. Runtime does not auto-approve a plan merely because deterministic validators pass, and it does not silently erase blocking risk/follow-up text. A model still performs the bounded semantic re-review, but its authority is restricted to the exact review scope that caused the repair.

A fresh full task retry remains the semantic reset boundary. That retry may legitimately discover a new issue because it is a new Technical Lead attempt, while same-attempt repair remains a finite correction loop.

The live qualification that motivated this ADR cannot prove which exact semantic delta persisted because the prior qualification report did not capture it. The added event/qualification evidence closes that observability gap for the next target-host run.
