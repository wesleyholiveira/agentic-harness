# Agentic Harness source of truth

This repository is the canonical source for the reusable Agentic Harness. Consuming repositories should include a **qualified tag** as a Git submodule rather than copying harness files into product source.

## Authority boundary

The harness is authoritative for:

- specialist capability manifests and orchestration policy;
- SDD schemas, templates and workflow contracts;
- Runtime V2 control/execution plane implementation;
- Context Engine and ProjectMemory integration;
- OpenCode configuration/plugins and external-tool wiring;
- harness-owned database migrations and operational entrypoints.

A consuming repository remains authoritative for its domain code, product requirements, project ADRs/designs/runbooks, and run-specific Task Briefs/Context Packets.

## Runtime invariants

- PostgreSQL is durable run/task/checkpoint/continuation/ProjectMemory authority.
- RabbitMQ is at-least-once transport, never completion authority.
- Rust workers are replaceable physical executors.
- Semantic retry identity is `attempt`; physical replacement advances `dispatchGeneration` and `fencingToken` while preserving the semantic attempt when checkpoint repair is valid.
- Context Engine owns context construction/finalization; Redis/TEI remain reconstructible dependencies.
- OpenCode/model output proposes work and handoffs; durable Runtime evidence proves completion.

## Dynamic agent topology

`.agents/agents/<id>/agent.json` describes capability and ownership hints only. There is no monolithic static call graph. Technical Refinement emits the implementation plan and the Runtime compiler derives the task DAG for the current request.

## Submodule roots

- `AGENT_HARNESS_ROOT`: this repository/submodule.
- `AGENT_HARNESS_PROJECT_ROOT`: consuming repository.

Never collapse these roots in code that reads project context or writes project runtime evidence. A stale inherited `AGENT_HARNESS_PROJECT_ROOT` that resolves to harness source (including a different outer checkout) is not allowed to redirect an invocation made from a real external consumer containing the active harness submodule; the public launcher must recover the consumer cwd and expose that resolution decision in diagnostics.

## Stable public interface

The supported CLI surface is the ten `harness:*` commands in `package.json` / `bin/harness.mjs`. `harness:migrate` is the supported submodule-facing migration entrypoint and executes the internal migrator through the consumer-scoped `database-migrate` Compose service; direct host execution of the migration helper is internal. Internal migration, executor, replay and readiness helpers are implementation details and may evolve without becoming public aliases.

## Promotion rule

A new harness tag is promoted only from an immutable source tree after the standalone contract suite and target-host qualification pass. Historical Runtime qualification under `qualification/baseline/` is lineage evidence, not permission to skip qualification after genericization or future source changes.
