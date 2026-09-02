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

## Agent discovery

`loadAgentCatalog()` discovers `.agents/agents/*/agent.json`; no monolithic registry file or static graph exists. Manifests contain capabilities/ownership hints. The run DAG is synthesized from impact-selected reviews plus the schema-valid Technical Refinement implementation plan.

## Execution plane

Context Engine creates authoritative preparation/finalization state. PostgreSQL/outbox + RabbitMQ dispatch work to the Rust worker. The worker executes the prepared descriptor, persists physical identity and routes semantic work through OpenCode. Process loss after a valid repair checkpoint stays on the same semantic attempt while generation/fence advance.

## OpenCode

The host launcher generates `.runtime/opencode.effective.json` from `config/opencode.template.jsonc`, expands absolute roots, starts the Headroom wrapper by default and exposes the session host on port 4096. Runtime child OpenCode disables nested MCPs that should not be recursively launched inside worker execution.

## Extensibility

A consuming project may add domain-specific agents in its own source or in a future extension layer, but the base harness does not carry product agents. New capability manifests must not encode static dependencies.
