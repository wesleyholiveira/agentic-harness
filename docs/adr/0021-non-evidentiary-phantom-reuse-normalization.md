# ADR 0021 — Non-evidentiary phantom reuse normalization for zero-file governance reviews

## Status
Accepted

## Context

The standalone Runtime treats the mutable workspace and its baseline as the physical authority for repository path disposition. Agent handoffs classify output paths as `changedPaths`, `reusedPaths`, or read-only context. `reusedPaths` is intentionally narrow: the path must already exist, be owned by the task, remain byte-identical to baseline, and be accepted as task output without modification.

A target-host qualification proved the shared workspace authority from ADR 0020 in R-4 and then advanced Product Discovery to `integrated`. Architecture Review executed successfully and emitted `completion.proven`, but finalization failed because the model declared:

`docs/architecture/example-anonymous-fallback.md`

as a reused path even though the qualification fixture never contained that file and the review did not create it. The bootstrap review task has `role=contract` and `estimatedFiles=0`; its acceptance criteria are handoff/evidence criteria, not a requirement to materialize an architecture document.

The existing Runtime already normalizes a symmetric bookkeeping mistake: when an owned path is reported in `reusedPaths` but workspace inspection proves that it changed, the path is reclassified to `changedPaths`. Treating every impossible `reusedPaths` claim as a terminal semantic failure therefore makes model-side path bookkeeping stronger than the physical workspace authority.

The repair must not allow a nonexistent artifact to satisfy evidence. If a criterion, validation result, SDD review, finding, risk, contract change, assumption, or any other handoff evidence refers to the nonexistent path, the handoff must remain fail-closed.

## Decision

`verifyReusablePath()` distinguishes these states:

- `missing_in_workspace`: the artifact existed in baseline but is absent now;
- `missing_in_baseline`: the artifact exists now but was not reusable baseline output;
- `missing_in_workspace_and_baseline`: the artifact exists in neither authority and is therefore a phantom reuse declaration.

The Runtime may drop `missing_in_workspace_and_baseline` from `reusedPaths` only when all conditions hold:

1. task `role` is `contract`;
2. task stage ends in `-review`;
3. `estimatedFiles === 0`;
4. handoff status is `complete`;
5. the path is owned by the review;
6. workspace inspection shows no actual change for the path;
7. baseline contains no such path;
8. the path does not appear anywhere else in the handoff outside `changedPaths`, `reusedPaths`, or `usedContextPaths`.

The normalized path is not converted into evidence, not materialized, and not treated as a successful reuse. It is removed from the path-disposition envelope and an auditable event is emitted:

`workspace.phantom_reused_paths_dropped`

with authority `workspace_and_baseline_absence`.

All other cases remain fail-closed. In particular:

- a baseline artifact that disappears is invalid;
- a nonexistent path referenced by criterion/validation/SDD evidence is invalid;
- implementation, QA, readiness, Product Acceptance, and non-zero-file tasks cannot use this normalization;
- unauthorized or context-only paths remain invalid;
- actual workspace changes remain authoritative and must be reported/integrated as changes.

The bootstrap governance executor prompt also states that zero-file reviews must not invent architecture/ADR/review artifact paths merely to populate `changedPaths` or `reusedPaths`.

## Consequences

- Physical workspace/baseline authority wins over a non-evidentiary model bookkeeping hallucination.
- A nonexistent file can never become proof by virtue of being listed in `reusedPaths`.
- Genuine missing/deleted artifacts remain fail-closed.
- Governance review completion can be represented entirely by structured handoff evidence when the planner explicitly estimates zero repository files.
- The repair is deterministic and auditable and does not consume another model invocation.
