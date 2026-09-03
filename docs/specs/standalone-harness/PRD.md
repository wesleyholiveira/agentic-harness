# PRD — Standalone Agentic Harness

## Problem

A mature multi-agent runtime cannot be safely reused when its orchestration source, OpenCode configuration, specialist definitions, SDD rules and infrastructure are mixed with one product repository. Copying those files into every project creates drift and makes qualification lineage impossible to track.

## Product goal

Provide one official, project-agnostic Git repository that can be mounted as a submodule and supplies a complete specialist-agent engineering harness while the consuming repository remains the sole domain/product authority.

## Acceptance criteria

- **HARNESS-1:** the harness and consuming project have explicit independent roots and no symlink/copy requirement; a stale inherited project-root variable that resolves to harness source, including another harness checkout, cannot override a real external consumer invocation root.
- **HARNESS-2:** specialist manifests are distributed and contain no static run DAG/delegation graph.
- **HARNESS-3:** Technical Refinement `implementationPlan` is the authority compiled into the runtime DAG.
- **HARNESS-4:** PostgreSQL/RabbitMQ/Rust/Context Engine/OpenCode authority and recovery invariants from the promoted Runtime baseline are preserved.
- **HARNESS-5:** OpenCode configuration is path/user/project agnostic and supports Headroom, Serena, Context7, codebase-memory, RTK and optional Caveman.
- **HARNESS-6:** harness-owned skills, schemas and SDD templates are local; Superpowers is pinned and vendorable to a fully local tree.
- **HARNESS-7:** product/domain source, domain specialists and project-specific PRDs/ADRs are absent from operational harness source.
- **HARNESS-8:** `package.json` exposes a small lifecycle-oriented command API rather than version-specific check aliases.
- **HARNESS-9:** the promoted R17.4.5 source/recovery evidence is retained as immutable lineage but is not represented as qualification of the genericized repository.
- **HARNESS-10:** a standalone contract suite proves the reusable boundary before distribution.
- **HARNESS-11:** each consuming project receives an independent Docker Compose runtime namespace so containers, networks and named durable volumes cannot be silently shared across unrelated consumers.
- **HARNESS-12:** the public migration surface works from a clean Git submodule without consumer-local `node_modules`; migration execution uses the consumer-scoped runtime image/network while preserving the single harness-owned SQL migration implementation.

## Non-goals

The repository does not prescribe a product architecture, business domain, deployment cloud or project acceptance criteria. It does not promote alternative LLMs without project-local qualification. It does not turn RabbitMQ, Redis, TEI or OpenCode into durable state authority.
