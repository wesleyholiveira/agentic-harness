# ADR 0001 — Dual-root submodule boundary

**Status:** Accepted

## Context

The harness is consumed as a Git submodule. Therefore the harness source tree and the consuming project source tree are different repositories with different ownership and lifecycle.

## Decision

Use two explicit roots:

- `AGENT_HARNESS_ROOT`: immutable/reusable harness source — agents, schemas, runtime, plugins, integrations and migrations.
- `AGENT_HARNESS_PROJECT_ROOT`: consuming project — application code, project PRDs/ADRs, generated Task Briefs/Context Packets, workspaces and `.runtime` evidence.

Context Engine and Runtime load executable harness authority from the harness root while all project analysis and workspaces remain rooted in the consuming project.

## Consequences

A submodule can be updated independently without copying harness files into the project. Windows does not require symlinks. Any code that conflates the two roots is a blocking defect.
