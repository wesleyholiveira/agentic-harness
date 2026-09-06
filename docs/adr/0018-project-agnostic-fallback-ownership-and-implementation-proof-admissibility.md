# ADR 0018 — Project-agnostic fallback ownership and implementation-proof admissibility

**Status:** Accepted

## Context

A fresh standalone R-7 proved that Product Discovery and Architecture Review could integrate and that Technical Refinement could execute normally, but the final Technical Lead implementation plan was deterministically rejected on every retry:

- `coding-pro` was selected for `src/format-name.mjs` and `test/format-name.test.mjs`, while both generic coding manifests had no explicit ownership patterns;
- the Product Owner criterion catalog contained no criterion with `proofStage=implementation`, so no implementation work item could satisfy the compiler's requirement to own at least one implementation-proof criterion.

The first condition made the generic coding agents structurally selectable but unusable. The second allowed Product Discovery to emit a schema-valid catalog that could never become a compilable implementation DAG.

## Decision

### Generic coding ownership

`coding-fast` and `coding-pro` declare `ownershipMode=fallback-unclaimed-primary`.

A fallback owner may own a repository-relative path only when no non-fallback implementation/platform agent declares a matching `primaryPaths` rule for that path. Explicit primary domain ownership always wins. Shared/collaborative patterns permit cooperation but do not reserve otherwise-unclaimed project paths against the generic fallback.

The Runtime compiler remains the final authority. This is not equivalent to granting `**`: a fallback coder is rejected for `src/server/**` when `backend-specialist` has primary ownership, while it may own generic consumer paths such as `src/format-name.mjs` and `test/format-name.test.mjs` when no domain primary owner exists.

The compact Technical Refinement ownership projection exposes `ownershipMode`, and both the normal executor prompt and the bounded technical-plan synthesis prompt explain the same rule.

### Product criterion admissibility

A completed Product Discovery handoff must contain at least one product acceptance criterion with `proofStage=implementation`.

This follows from the current Runtime topology: every delivery/change run reaches Technical Refinement, the implementation plan contains one or more implementation work items, and every implementation work item must own at least one implementation-proof criterion.

If the Product Owner emits a valid-looking catalog with no implementation proof, the same-attempt Product Discovery criteria projection repairs only `proofStage` on an existing criterion that is genuinely implementation-provable. It may not invent a criterion or mutate the criterion's `id`, `source`, `statement`, `blocking`, or `verification`. If evidence contains no such criterion, the Runtime fails closed.

## Consequences

- generic consumers are no longer forced to mirror harness-specific `src/api`, `src/server`, frontend, database or infrastructure directory conventions;
- domain primary ownership remains fail-closed and cannot be bypassed by a generic coder;
- Product Discovery cannot integrate a criterion catalog that makes Technical Refinement structurally impossible;
- Technical Refinement retries remain reserved for actual plan-quality problems rather than impossible upstream authority.
