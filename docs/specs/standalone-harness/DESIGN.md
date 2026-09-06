# Design — Standalone Agentic Harness

## Topology

```text
consuming repository                    agentic-harness submodule
--------------------                    -------------------------
product code / PRDs / ADRs              agents + skills + schemas
project AGENTS.md                       SDD workflow + templates
.runtime evidence                       Runtime semantic plane
        |                               Context Engine
        | AGENT_HARNESS_PROJECT_ROOT    Rust worker
        +------------------------------>OpenCode plugins/config
                                        migrations/tool wrappers
                                        qualification lineage
```

Runtime services see `/workspace/repository` as project authority and `/workspace/harness` as harness authority.

The public launcher resolves project authority before dispatching any lifecycle command. `AGENT_HARNESS_PROJECT_ROOT` is honored when it resolves outside the harness. If it is inherited from an outer harness session and resolves to harness source (the active submodule or another harness checkout) while the invocation cwd is an external Git consumer containing the active submodule, the launcher selects the consumer cwd instead and records the stale-self-root correction. This prevents bootstrap, `.runtime`, OpenCode and Compose state from being redirected into reusable harness source.


Operational public identifiers are genericized at the standalone boundary: Runtime MCP tools and Prometheus metrics use the `agent_harness_*` namespace, and validation markers must not retain pre-standalone product-specific names. Historical lineage under `qualification/baseline/**` is the only allowed location for those identifiers.

Docker Compose is a third derived runtime identity, not a source authority. `bin/harness.mjs` computes `agentic-harness-<sha256-prefix>` from the canonical consuming-project root and passes it with `docker compose -p` for lifecycle commands. This prevents unrelated consumers from sharing Compose networks or named durable volumes. `AGENT_HARNESS_COMPOSE_PROJECT_NAME` is the only explicit override; an inherited generic `COMPOSE_PROJECT_NAME` cannot collapse consumer isolation. The fixed top-level Compose `name:` is intentionally absent.

The public migration surface is also containerized under that same Compose identity. `harness:migrate` runs the `database-migrate` service rather than importing `pg` from the host submodule. The service image is built from the harness lockfile with `npm ci`, contains the same `scripts/harness-migrate.mjs` implementation and resolves PostgreSQL through the internal `postgres` service name. A clean consumer `.harness` therefore requires no copied dependency tree.

## Agent discovery

`loadAgentCatalog()` discovers `.agents/agents/*/agent.json`; no monolithic registry file or static graph exists. Manifests contain capabilities/ownership hints. The run DAG is synthesized from impact-selected reviews plus the schema-valid Technical Refinement implementation plan.

## Execution plane

Context Engine creates authoritative preparation/finalization state. PostgreSQL/outbox + RabbitMQ dispatch work to the Rust worker. The worker executes the prepared descriptor, persists physical identity and routes semantic work through OpenCode. Process loss after a valid repair checkpoint stays on the same semantic attempt while generation/fence advance.

## OpenCode

The persistent Main Orchestrator is a control-plane-only session. For delivery/change requests, it must enter Runtime V2 through Context Engine `agent_start`; direct `write`/`edit`/`apply_patch`, `bash`, built-in `task`, and Serena mutation paths are denied in agent permissions and independently fenced by the provenance plugin. Runtime child specialists are explicitly exempt from that host fence so implementation remains possible only after Runtime dispatch.

Standalone promotion is driven by a separate deterministic host qualification controller (`harness:qualify`), not by the Main Orchestrator. The controller owns shell/Git/Docker/Cargo/HTTP probes, external consumer creation, fault injection, evidence capture and cleanup. It never calls Runtime `agent_start` directly; the only model-facing promotion boundary is the normal R-7 consumer request sent to a fresh qualified OpenCode session.

The host launcher generates `<AGENT_HARNESS_PROJECT_ROOT>/.runtime/opencode.effective.json` from `config/opencode.template.jsonc`, expands absolute roots, starts the Headroom wrapper by default and exposes the session host on port 4096. The plugin/config source remains harness-owned while generated runtime evidence remains project-owned. Runtime invocation provenance is routed to the same effective Context Engine authority as the generated MCP configuration (including qualification-specific ports). The public launcher hashes the active provenance plugin once and projects that identity to both the OpenCode host and Context Engine; the host plugin self-verifies it and the Context Engine verifies its bundled copy before readiness, so the first live registration is not the first point where revision skew can be detected. Runtime child OpenCode disables nested MCPs that should not be recursively launched inside worker execution.

## Extensibility

A consuming project may add domain-specific agents in its own source or in a future extension layer, but the base harness does not carry product agents. New capability manifests must not encode static dependencies.
