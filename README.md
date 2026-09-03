# Agentic Harness

A project-agnostic, submodule-friendly multi-agent engineering harness derived from the **promoted Runtime V2 R17.4.5 baseline**.

The consuming repository owns product/domain code and specification. This repository owns reusable orchestration, SDD contracts, specialist agents, runtime infrastructure, OpenCode integration and operational tooling.

## What is included

- **SDD pipeline:** Product Discovery → impact-selected architecture/database/infrastructure/security/AI reviews → Technical Refinement → runtime-compiled implementation DAG → QA → conditional readiness → Product Acceptance.
- **Dynamic agent topology:** distributed `.agents/agents/<id>/agent.json` capability manifests; there is no monolithic static call-graph registry.
- **Runtime V2 core:** PostgreSQL durable authority, RabbitMQ at-least-once transport, Rust executor, semantic attempt vs. physical generation/fence identity, checkpoint repair and durable OpenCode continuation.
- **Context Engine:** PostgreSQL Project Memory, Redis exact/semantic cache, optional TEI embeddings, CBM/Context7/Serena adapters.
- **Portable OpenCode surface:** Main Orchestrator and specialist definitions, project plugins, progress/provenance/continuation tooling and the `sdd` command.
- **Tool integrations:** Headroom 0.36.5 wrapper/MCP, Serena 1.7.0, Context7, codebase-memory-mcp, optional Caveman and RTK guidance.
- **Skills:** harness-owned skills are fully local. Superpowers is pinned at v5.1.0 and the complete 14/14 locked skill tree is vendored under `vendor/superpowers/skills`; `scripts/vendor-superpowers.mjs` is an explicit refresh/verification path, not a bootstrap requirement.
- **Generic SDD artifacts:** schemas and editable templates for PRD, ADR, Design, Test Plan, Runbook, Task Brief, Context Packet, Implementation Plan, Handoff Result, Replay Capsule and related runtime artifacts. The repository’s own current PRD/design/plan/briefs/packets live under `docs/specs/standalone-harness/`.
- **Qualification lineage:** the immutable R17.4.5 promotion evidence is retained under `qualification/baseline/r17.4.5/` and is not operational source.

## Stable command surface

```bash
npm run harness:bootstrap
npm run harness:doctor
npm run harness:up
npm run harness:down
npm run harness:logs
npm run harness:migrate
npm run harness:test
npm run harness:qualify
npm run harness:opencode
npm run harness:clean
```

Those are intentionally the only public package scripts. Versioned R12–R17 contract commands are not part of the standalone public API.

## Two-root model

`AGENT_HARNESS_ROOT` points at this repository/submodule. `AGENT_HARNESS_PROJECT_ROOT` points at the consuming repository. Runtime code, agent manifests, schemas and OpenCode plugins come from the harness root; workspaces, project PRDs/ADRs/code and all generated `.runtime` evidence—including `opencode.effective.json`—come from the consuming project root. When the public launcher is invoked from an external consumer that contains this harness as a submodule, a stale inherited `AGENT_HARNESS_PROJECT_ROOT` resolving to a harness source checkout is ignored in favor of that consumer cwd; explicit project roots outside the harness remain authoritative. `harness:doctor`/bootstrap report the selected root source so this correction is auditable. Docker Compose runtime identity is also consumer-scoped: the launcher derives a deterministic project name from the canonical consuming-project root so containers, networks and named volumes are not shared across unrelated consumers. Set `AGENT_HARNESS_COMPOSE_PROJECT_NAME` only for an explicit namespace override.

See `docs/sdd/SUBMODULE-INTEGRATION.md` for installation and `docs/architecture/DECISIONS.md` for the current reusable architecture.

## Distribution status

See [`DISTRIBUTION-REPORT.md`](DISTRIBUTION-REPORT.md) for the standalone extraction boundary, promoted R17.4.5 lineage, validation evidence, complete Superpowers vendor status and target-host qualification requirements.
