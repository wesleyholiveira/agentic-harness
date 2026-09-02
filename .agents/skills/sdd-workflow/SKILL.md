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

## Superpowers integration

Use `brainstorming` before design, `writing-plans` for executable planning, `test-driven-development` during implementation, `systematic-debugging` on failures, `requesting-code-review`/`receiving-code-review` for review loops, and `verification-before-completion` before any completion claim.
