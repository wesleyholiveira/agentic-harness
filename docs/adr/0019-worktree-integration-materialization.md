# ADR 0019 — Worktree integration must materialize new files before downstream verification

## Status
Accepted

## Context

Standalone qualification advanced through Product Discovery, Architecture Review, Technical Refinement, and an implementation task. The implementation task reached `integrated`, but downstream QA blocked because the implementation and test files named by the upstream handoff were absent from the QA workspace. The validation command therefore discovered zero tests and was correctly treated as vacuous evidence.

The implementation workspace may run as a detached Git worktree. Runtime integration previously built the patch with:

```text
git diff --binary HEAD -- <changedPaths>
```

Git does not include brand-new untracked files in that diff. A task that created new files could therefore produce an authoritative Rust/semantic change-set and a valid handoff, yet integration would apply an empty or incomplete patch and still mark the task `integrated`.

## Decision

Worktree integration must make the already-reconciled `changedPaths` visible to Git diff using intent-to-add before generating the binary patch:

```text
git add -N -- <changedPaths>
git diff --binary HEAD -- <changedPaths>
```

The intent-to-add mutation occurs only inside the disposable task worktree after agent execution. It does not change the consumer repository index.

Worktree change inspection also combines tracked changes with:

```text
git ls-files --others --exclude-standard
```

so newly created files are visible even when no external change-set authority is supplied.

After integration, Runtime must compare each changed path's workspace fingerprint with the materialized consumer-root fingerprint. A mismatch records `workspace.integration_materialization_mismatch`, creates an `integration_materialization_mismatch` conflict, and fails integration. `markIntegratedPath` occurs only after byte-equivalent materialization is proven.

## Consequences

- New source/test files created by implementation worktrees are available to downstream QA and Product Acceptance workspaces.
- Modified and deleted files keep the existing binary-patch path.
- A task can no longer be reported as `integrated` when its declared/reconciled change-set is absent or byte-different in the consumer repository.
- Workspace isolation remains intact; downstream tasks still receive fresh workspaces derived from the integrated consumer root.
- Fail-closed conflict and ownership rules remain unchanged.
