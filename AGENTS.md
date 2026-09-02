# Agentic Harness — repository instructions

This repository is a project-agnostic agent harness. A consuming project is the domain authority; this submodule supplies orchestration, SDD, specialist agents, schemas, Context Engine and Runtime V2.

## Authority order
1. User request and consuming-project policies.
2. Accepted PRD/ADR/design artifacts in the consuming project.
3. Task Brief + Context Packet + implementation plan for the current run.
4. This harness's schemas/runtime contracts.

## Rules
- The dynamic DAG is runtime authority. Agent manifests describe capabilities/ownership hints only.
- Do not create a static call graph in an agent manifest.
- Use SDD for non-trivial changes.
- Use Superpowers process skills where applicable.
- Prefer focused tests and evidence over broad speculative edits.
- PostgreSQL is durable runtime authority; RabbitMQ is transport; workers are replaceable.
