# ADR 0002 — Distributed capability catalog and runtime DAG

**Status:** Accepted

## Context

A monolithic agent registry encoded both capability metadata and orchestration relationships. That duplicated topology which is now derived from Technical Refinement at runtime and made every new specialist a central-registry edit.

## Decision

Discover agents from `.agents/agents/<agent-id>/agent.json`. Each manifest declares identity, role, capabilities, ownership hints, skills and routing hints only. Static `dependsOn` and delegation graphs are forbidden.

Technical Refinement emits `implementationPlan`. Runtime validates ownership and compiles its work-item dependencies into `dynamic-dag-v2`. Review stages are selected from impact facts rather than a fixed global sequence.

## Consequences

Adding a specialist is a local manifest operation. The planner owns run-specific topology. A small internal catalog loader may aggregate manifests for validation/lookup, but there is no `.agents/registry.json` authority or static call graph.


## Legacy wire compatibility

Some durable Runtime schemas still contain identifiers such as `registryFingerprint` because they are part of the promoted replay/evidence contract. In the standalone harness those fields fingerprint the **distributed agent catalog**; they do not imply that `.agents/registry.json` exists or that a static orchestration graph is authoritative. Renaming those durable fields requires a separately versioned schema migration.
