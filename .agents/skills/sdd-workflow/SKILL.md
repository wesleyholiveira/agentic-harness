---
name: sdd-workflow
description: Project-agnostic specification-driven development through Product Discovery, Architecture, Technical Refinement, dynamic implementation DAG, QA, readiness and Product Acceptance.
---
# SDD Workflow

Use this skill for non-trivial feature, refactor, migration, architecture, infrastructure or cross-cutting changes.

## Contract

1. Product Discovery writes/revises the PRD and immutable acceptance criteria.
2. Required specialist reviews are selected from impact facts; reviews are not a fixed serial pipeline.
3. Technical Refinement emits a schema-valid `implementationPlan` with bounded work items, exact owners, paths, dependencies and executable validation.
4. Runtime V2 compiles the implementation plan into a dynamic DAG. Agent manifests are a capability/ownership catalog only; they never encode call order.
5. Implementation tasks receive a Task Brief + Context Packet + manifest-authorized upstream artifacts.
6. QA independently verifies acceptance evidence.
7. Operational Readiness is conditional on actual infrastructure/runtime impact.
8. Product Acceptance closes against the original acceptance criteria.

## Required invariants

- PostgreSQL is Runtime authority; RabbitMQ is transport only.
- At-least-once transport requires idempotent/effect-keyed consumers.
- Physical worker loss must preserve semantic attempt and advance dispatch generation/fencing token.
- Durable continuation is the only autonomous resume path for a parked outer controller.
- No agent may weaken acceptance criteria, silently widen ownership, or substitute prose for executable validation.
- Source changes during a qualification invalidate downstream qualification evidence.

## Persistent Main Orchestrator boundary

When this skill is loaded by the persistent Main Orchestrator, it describes the Runtime-owned workflow; it does not authorize executing the workflow locally. For a delivery/change request, the persistent Main Orchestrator captures `runtime-continuation`, calls Context Engine `agent_start` with that continuation, and parks for the durable resume event. It must not invoke Superpowers design/implementation process skills or ask for a redundant design/proceed approval before Runtime ingress when the request is already actionable.

## Superpowers integration

For Runtime-dispatched specialist children, Superpowers is stage-compatible guidance rather than a second workflow authority. Implementation specialists may use `test-driven-development`, `systematic-debugging`, code-review skills and `verification-before-completion` when those skills match the Task Brief. Technical Refinement is different: it is a non-interactive contract stage whose authoritative output is the schema-valid `implementationPlan`; it must not run `brainstorming`, `writing-plans`, `using-git-worktrees`, `requesting-code-review`, or other human execution-choice workflows before emitting that plan. Runtime plan validation and bounded review repair own Technical Refinement closure.
