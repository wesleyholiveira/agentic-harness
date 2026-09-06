# ADR 0010 — Deterministic standalone qualification controller

Status: Accepted

## Context

The v1.0.0 standalone promotion qualification was originally expressed as a very large natural-language runbook executed by an outer LLM/controller. The qualification found real source/runtime defects, but it also accumulated false HOLDs caused by controller implementation details: shell redirection, MSYS path translation, temporary Compose files, JSON versus NDJSON parsing, path canonicalization, inline JavaScript escaping, and ad-hoc probe rewrites.

A later R-7 qualification found a real runtime boundary defect: the persistent Main Orchestrator could directly edit/execute instead of entering Runtime V2 through `agent_start`. The remediation correctly made the Main Orchestrator control-plane only by denying edit/bash/task/Serena bypasses. That means the Main Orchestrator must not also be asked to act as the qualification executor.

## Decision

1. `npm run harness:qualify` is the supported standalone promotion controller.
2. `scripts/harness-qualify.mjs` launches `scripts/qualification/standalone-v1.mjs` as a normal host process with `shell:false`.
3. The qualification controller is external to the 20-agent operational catalog and is not an OpenCode agent.
4. PRE-R0 through R-6 and R-8 through R-11 are deterministic code/probe gates executed by the controller using Git, Node, Docker/Compose, Cargo, HTTP, PostgreSQL evidence and process control.
5. R-7 is the intentional model-facing boundary: the controller sends a normal consumer request to a fresh qualified OpenCode session. Only the qualified persistent Main Orchestrator may call Context Engine `agent_start`.
6. The controller never directly calls Runtime `agent_start` or Runtime MCP tools as a substitute for qualification execution.
7. Qualification state, command logs and reports are written outside tracked harness source by default under the host temporary directory, or to an explicit `--output` directory.
8. The controller is fail-closed: after the first divergence, downstream gates are marked NOT RUN and only R-11 cleanup/source-equality checks execute.
9. Qualification-owned Compose projects, containers, sessions and consumers have explicit identities and cleanup. Pre-existing resources are recorded and preserved.
10. `--self-test` validates the controller wiring/report contract without Docker, OpenCode or model execution and is part of the standalone contract suite.

## Consequences

The Main Orchestrator can remain safely restricted from shell/edit while the promotion controller retains the host capabilities required to test the harness. The highest-risk qualification mechanics are versioned code instead of natural-language reinterpretation. The human-readable runbook becomes an operational description of the CLI rather than an executable prompt.
