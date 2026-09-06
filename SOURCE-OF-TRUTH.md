# Agentic Harness source of truth

This repository is the canonical source for the reusable Agentic Harness. Consuming repositories should include a **qualified tag** as a Git submodule rather than copying harness files into product source.

## Authority boundary

The harness is authoritative for:

- specialist capability manifests and orchestration policy;
- SDD schemas, templates and workflow contracts;
- Runtime V2 control/execution plane implementation;
- Context Engine and ProjectMemory integration;
- OpenCode configuration/plugins and external-tool wiring;
- Operational MCP tool names, Prometheus metric families and Runtime validation markers use the project-agnostic `agent_harness_*` namespace. Product-lineage identifiers from the pre-standalone product are permitted only inside immutable qualification provenance under `qualification/baseline/**`.
- harness-owned database migrations and operational entrypoints.

A consuming repository remains authoritative for its domain code, product requirements, project ADRs/designs/runbooks, and run-specific Task Briefs/Context Packets.

## Runtime invariants
- Execution-plan workflow review projections include `requiresSecurity` as a schema-required boolean; provisional bootstrap forces it false and refined topology derives it from the selected `security-review` capability.
- Persistent Main Orchestrator delivery ingress is `runtime-continuation` → `agent_start({ continuation })`; `agent_runs` proves run existence and `agent_continuations` separately proves durable OpenCode session binding.
- Qualification R-4 treats container `Running` and application HTTP readiness as separate proofs; Context Engine, RabbitMQ Management and embeddings must pass bounded HTTP readiness with preserved transport-cause evidence.
- The deterministic qualification controller is host-side and cross-platform: on Windows it resolves `PATH`/`PATHEXT`, directly spawns native executables, and explicitly wraps `.cmd/.bat` shims through `ComSpec` without enabling `shell:true`; batch shims use the `cmd.exe /S /C` outer-quote form with `windowsVerbatimArguments=true` so paths containing spaces are preserved without literal backslash-escaped quotes.
- The persistent Main Orchestrator is control-plane only: delivery/change requests must enter through Context Engine `agent_start`; direct edit/write/patch/bash/task/Serena execution is fail-closed, while Runtime child specialists retain implementation tools.

- PostgreSQL is durable run/task/checkpoint/continuation/ProjectMemory authority.
- RabbitMQ is at-least-once transport, never completion authority.
- Rust workers are replaceable physical executors.
- Semantic retry identity is `attempt`; physical replacement advances `dispatchGeneration` and `fencingToken` while preserving the semantic attempt when checkpoint repair is valid.
- Context Engine owns context construction/finalization; Redis/TEI remain reconstructible dependencies.
- OpenCode/model output proposes work and handoffs; durable Runtime evidence proves completion.
- Runtime invocation provenance must register against the same effective Context Engine authority used by the OpenCode MCP configuration. The launcher projects one exact provenance-plugin SHA from the active harness source; the OpenCode plugin must self-match it, and the Context Engine must prove its packaged plugin copy matches it before readiness.

## Dynamic agent topology

`.agents/agents/<id>/agent.json` describes capability and ownership hints only. There is no monolithic static call graph. Technical Refinement emits the implementation plan and the Runtime compiler derives the task DAG for the current request.

## Submodule roots

- `AGENT_HARNESS_ROOT`: this repository/submodule.
- `AGENT_HARNESS_PROJECT_ROOT`: consuming repository.

Never collapse these roots in code that reads project context or writes project runtime evidence. A stale inherited `AGENT_HARNESS_PROJECT_ROOT` that resolves to harness source (including a different outer checkout) is not allowed to redirect an invocation made from a real external consumer containing the active harness submodule; the public launcher must recover the consumer cwd and expose that resolution decision in diagnostics.

## Stable public interface

The supported CLI surface is the ten `harness:*` commands in `package.json` / `bin/harness.mjs`. `harness:migrate` is the supported submodule-facing migration entrypoint and executes the internal migrator through the consumer-scoped `database-migrate` Compose service; direct host execution of the migration helper is internal. Internal migration, executor, replay and readiness helpers are implementation details and may evolve without becoming public aliases.

## Promotion rule

A new harness tag is promoted only from an immutable source tree after the standalone contract suite and target-host qualification pass. `npm run harness:qualify` is the deterministic outer qualification authority; it is not an OpenCode agent and never delegates the runbook itself to Runtime V2. The persistent Main Orchestrator stays control-plane only and is exercised as a normal consumer-facing agent only at the live R-7 workload boundary. Historical Runtime qualification under `qualification/baseline/` is lineage evidence, not permission to skip qualification after genericization or future source changes.

- The R-0 legacy product-namespace scan must not embed its own forbidden identifier as a literal; the pattern is composed from fragments at runtime and a contract proves zero operational self-matches outside historical baseline provenance.

- HTTP `main-orchestrator` `agent_start` is fail-closed on consumed OpenCode provenance (`opencode-plugin-sidechannel`, session id, user message id). Runtime run materialization therefore proves provenance without relying on optional logs.
