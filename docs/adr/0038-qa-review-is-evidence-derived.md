# ADR 0038 — Quality Assurance review is evidence-derived

Status: accepted

## Context

Quality Assurance already emits the authoritative evidence needed to decide whether its task is proven: criterion results, Runtime-owned validation receipts, blocking residual risks, and required follow-ups. The Handoff also contains an `sddReview` envelope. Treating a model-authored negative `sddReview` as an independent veto can create a contradiction where every QA evidence channel proves success while the task still fails because the model echoes `changes_requested` without grounding that decision in any failed criterion, validation, blocking risk, or required follow-up.

This makes a non-deterministic summary field more authoritative than the evidence it is supposed to summarize.

## Decision

For `quality-assurance`, `sddReview` is an evidence-derived projection, not an independent semantic authority.

The Runtime continues to evaluate the QA Handoff fail-closed. Approval is eligible only when:

- every blocking Task Brief criterion has exactly one passed result with evidence;
- every blocking Task Brief validation command has exactly one passing Runtime receipt and no contradictory failure;
- no blocking final validation outside the required command set failed or blocked;
- no `blocking:` residual risk remains; and
- no `required:` follow-up remains.

When those evidence gates prove completion, a model-authored `changes_requested`/`blocked` review contradicts authoritative QA evidence. Structured finalization must project `decision=approved` and `requiredDeltas=[]` without changing the Handoff evidence body.

When any evidence gate is not proven, negative review decisions remain fail-closed and may not be upgraded. A genuine QA blocker therefore has to be represented in an authoritative evidence channel before it can justify a negative review.

A negative QA result is not automatically terminal. When the authoritative QA evidence identifies a repository-fixable code, test, documentation, or configuration delta, the Handoff uses `status=complete` with `sddReview.decision=changes_requested`, a concrete next role, and non-empty `requiredDeltas`. The Runtime re-opens the direct implementation dependencies under their existing attempt budgets, preserves the already-integrated repository state as the repair baseline, and defers the QA retry until those implementation dependencies integrate again. The next implementation Task Brief receives the QA diagnostic as authoritative retry context. QA then re-runs against only the newest accepted dependency artifact for each producer.

This feedback loop is bounded by the existing task `maxAttempts`; it does not create a separate unbounded review counter. If the implementation attempt budget is exhausted, no implementation task is re-opened. A `blocked` QA status/decision is reserved for a genuinely unresolved human/external authority or environmental condition that repository implementation cannot repair and remains terminal.

This rule is intentionally scoped to Quality Assurance. Product Acceptance remains a genuinely semantic acceptance authority, and other review/readiness stages are unchanged unless separately specified.

## Consequences

- QA no longer has two conflicting authorities for the same completion fact.
- Model variability in a redundant review summary cannot veto fully proven QA evidence.
- Genuine QA failures still prevent approval; repository-fixable failures drive bounded implementation repair, while human/external/environmental blockers remain terminal.
- QA repair reuses the compiled DAG and existing task attempt budgets rather than silently replanning or creating unbounded retry loops.
- Downstream consumers observe only the newest accepted artifact per direct dependency after a repair attempt, avoiding conflicting historical implementation evidence.
- The Runtime only canonicalizes the `sddReview` projection and schedules repair from explicit negative evidence; it never fabricates or rewrites criterion or validation evidence.
