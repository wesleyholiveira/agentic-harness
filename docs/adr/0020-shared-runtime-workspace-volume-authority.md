# ADR 0020 — Shared Runtime workspace volume authority

## Status
Accepted

## Context

The event-driven Runtime deliberately separates the consuming repository from mutable task workspaces. The Context Engine prepares semantic execution and finalizes results; the Rust worker physically materializes the repository snapshot, runs OpenCode, captures the change-set and schedules cleanup.

`resolveAgentWorkspaceRoot()` defaults outside the repository root. In the standalone Docker topology this produced paths such as `/workspace/.agentic-harness-agent-workspaces/repository/...` inside the worker container. Only `/workspace/repository` was bind-mounted into both the Context Engine and worker containers. The out-of-repository workspace path therefore existed only in the worker container filesystem.

A live standalone qualification exposed the split authority. Product Discovery completed successfully but finalization rejected an unchanged PRD reported in `reusedPaths` with `docs/specs/example/PRD.md:missing_in_workspace`. The worker had materialized and executed against a workspace that the Context Engine could not see. The same topology also explains downstream integration cases where a worker-local implementation workspace could not be copied into the consumer root by the Context Engine.

## Decision

The standalone Compose runtime owns one consumer-scoped named volume, `agent-harness-agent-workspaces`, mounted read-write at `/workspace/agent-workspaces` in both:

- `context-engine`; and
- `agent-runtime-worker`.

Both services receive:

`AGENT_HARNESS_AGENT_WORKSPACE_ROOT=/workspace/agent-workspaces`

The Runtime continues to keep workspaces outside `/workspace/repository`; it does not weaken `assertWorkspaceOutsideRepository()` and does not copy mutable workspace state into harness source or consumer `.runtime/**`.

The shared volume is ordinary non-external Compose state and therefore inherits the existing deterministic consumer-scoped Compose project identity. Unrelated consumers cannot silently share it, and `harness down --volumes` removes only the current consumer's workspace volume.

Qualification R-4 must fail closed unless Docker inspection proves that Context Engine and worker:

1. use the same workspace-root environment value;
2. mount a volume at that destination; and
3. resolve that mount to the same Docker volume source.

R-7 may then treat the workspace path carried in the execution result as a cross-container filesystem authority for reuse verification and integration.

## Consequences

- Semantic finalization can inspect worker-created baselines and files directly.
- Copy-workspace integration can materialize implementation changes into the consumer root before downstream QA.
- `reusedPaths` verification no longer depends on worker-local filesystem state being accidentally visible in another container.
- Workspace isolation from the consumer repository remains intact.
- Workspace storage is lifecycle-managed with the same Compose namespace as PostgreSQL, RabbitMQ and Redis.
