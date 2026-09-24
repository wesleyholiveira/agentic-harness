# ADR 0045 — Explicit plan-only execution intent and project planning evidence authority

## Status

Accepted — 2026-09-24.

## Context

The Runtime bootstrap always progresses from Product Discovery and governance reviews into Technical Refinement. Before this ADR, once the Technical Lead handoff was accepted, the event-driven reconciler always compiled the implementation DAG, materialized every implementation/QA/readiness/Product Acceptance task, and immediately dispatched ready implementation work.

That behavior made two distinct user intents indistinguishable:

- plan the implementation with SDD;
- plan and implement the change with SDD.

A planning-only request could therefore mutate execution state after the requested deliverable — a validated implementation plan — was already complete.

A second boundary existed in structured Technical Plan repair. The Runtime already projects repository references into Task Brief.readOnlyContextPaths, but the plan-synthesis evidence loader retained only a hard-coded subset under docs/plans, docs/specs, docs/architecture and .agent. Project-authoritative routing or work-item contracts stored elsewhere could disappear during a repair pass even though the Technical Lead had been allowed to read them.

## Decision

### 1. Execution intent is explicit plan state

ExecutionPlan/v2 carries workflow.executionIntent with these values:

- execute
- plan-only

Old plans that omit the field retain execute semantics for replay/backward compatibility.

Initial request classification is deterministic. Explicit execution verbs override planning language, so requests equivalent to "plan and implement" execute. Planning language without an execution verb produces plan-only. The noun "implementation" by itself is not execution authority; "plan the implementation" remains plan-only.

### 2. Plan-only still compiles the full DAG

Technical Refinement remains responsible for an executable implementationPlan. A plan-only run therefore still:

1. validates the Technical Lead handoff;
2. applies the normal compile policy;
3. compiles the complete future implementation DAG;
4. writes refined-dag.json;
5. updates the replay capsule with the compiled implementation plan.

The Runtime MUST NOT materialize the compiled implementation, QA, readiness or Product Acceptance tasks into the execution store for plan-only runs.

After successful compilation it closes the run with planning.completed, records the planned task IDs and refined DAG path, captures terminal replay evidence, and materializes the normal terminal continuation wake.

### 3. Structured repair preserves Runtime-authorized read-only context

Technical Plan synthesis/repair MUST preserve readable planning evidence from Task Brief.readOnlyContextPaths regardless of repository layout.

The existing handoff changed/reused-path filter remains narrow; arbitrary changed source files do not become planning authority merely because they changed. readOnlyContextPaths are different: they are already a Runtime projection of context that the task is explicitly allowed to consume. They remain read-only and budget bounded.

This keeps the harness project-agnostic while allowing repositories to place authoritative planning/routing material outside a hard-coded docs hierarchy.

### 4. Presentation distinguishes planned from materialized work

Run summaries expose executionIntent, refinedDagPath, plannedTaskIds and materialized newTaskIds. A closed plan-only run must therefore be visibly different from an implementation run and from a blocked implementation attempt.

## Consequences

A request that asks only for planning terminates successfully after validated DAG compilation and cannot accidentally start implementation.

A request that explicitly asks to implement preserves the existing full execution flow.

Project-specific routing constraints can survive deterministic/structured Technical Plan repair when they were projected into readOnlyContextPaths, without embedding project path conventions into the generic harness registry.

Because the new executionIntent field is optional in the schema, previously persisted/replayable plans continue to execute with legacy semantics.

## Validation

The contract suite must prove:

- a planning-only phrase equivalent to "plan the implementation with SDD" resolves to plan-only;
- "planeje e implemente" resolves to execute;
- the event-driven reconciler does not materialize planned implementation tasks for plan-only;
- plan-only produces planning.completed and a terminal continuation wake;
- summaries expose the compiled DAG and planned/materialized task counts;
- a Runtime-authorized readOnlyContextPaths file outside docs/** is preserved in Technical Plan synthesis evidence;
- an arbitrary changed file outside the historical planning prefixes is not promoted to evidence merely because it changed.
