# ADR 0001 — Dual-root submodule boundary

**Status:** Accepted

## Context

The harness is consumed as a Git submodule. Therefore the harness source tree and the consuming project source tree are different repositories with different ownership and lifecycle.

## Decision

Use two explicit roots:

- `AGENT_HARNESS_ROOT`: immutable/reusable harness source — agents, schemas, runtime, plugins, integrations and migrations.
- `AGENT_HARNESS_PROJECT_ROOT`: consuming project — application code, project PRDs/ADRs, generated Task Briefs/Context Packets, workspaces and `.runtime` evidence.

Context Engine and Runtime load executable harness authority from the harness root while all project analysis and workspaces remain rooted in the consuming project.

The public launcher normally runs from the consuming repository root. `AGENT_HARNESS_PROJECT_ROOT` remains an explicit authority for host-driven launches, but an inherited value that resolves to a harness source checkout (including another outer checkout of the same harness) must not override a real external consumer cwd that contains the active harness as a submodule. In that stale-self-root case the launcher selects the consumer cwd, records `projectRootResolution.source=consumer-cwd-over-stale-harness-env`, and propagates the corrected project root to bootstrap, doctor, Compose, OpenCode and runtime children. An explicit project root outside the harness remains authoritative.

## Consequences

A submodule can be updated independently without copying harness files into the project. Windows does not require symlinks. Any code that conflates the two roots is a blocking defect.
