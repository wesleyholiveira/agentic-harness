# ADR 0026 — Persistent Main Orchestrator Superpowers isolation

Status: Accepted

## Context

A fresh standalone target-host qualification passed Q-ENTRY through R-6 and reached the normal consumer workload at R-7. The persistent Main Orchestrator read the accepted PRD/ADR, produced a correct small design, and then asked the user to approve proceeding. It never called `runtime-continuation` or Context Engine `agent_start`, so no Runtime run or durable continuation was materialized and R-7 correctly held with `r7_main_orchestrator_failed_to_enter_runtime`.

The source contained conflicting process authority:

1. the persistent Main Orchestrator contract requires every actionable delivery/change request to enter Runtime V2 through `runtime-continuation` → `agent_start`;
2. the same Main Orchestrator manifest declared Superpowers `brainstorming` and other implementation-process skills;
3. the OpenCode Superpowers plugin injects its bootstrap process policy into every host chat;
4. `brainstorming` requires a design/proceed approval before implementation, including for simple changes.

That approval loop is valid inside a specialist design workflow, but it is invalid as a prerequisite to persistent-host Runtime ingress. Product Discovery, Technical Refinement and implementation specialists already own design/refinement inside Runtime V2.

## Decision

1. The persistent Main Orchestrator is an ingress/egress control plane and declares no `superpowersSkills`.
2. The generated Main Orchestrator permission map explicitly denies every Superpowers skill pinned by `vendor/superpowers/lock.json`. Harness-local control-plane skills remain available.
3. Host effective OpenCode config removes the Superpowers plugin and the vendored Superpowers skill path.
4. Runtime-child effective OpenCode config retains the pinned Superpowers plugin and vendored Superpowers skill path, so specialist SDD behavior is unchanged after Runtime ingress.
5. The Main Orchestrator prompt explicitly states that Runtime ingress takes precedence over generic design/implementation process guidance. An already-actionable request or accepted PRD/ADR must not receive an extra design/proceed approval gate before `agent_start`.
6. The `sdd-workflow` skill states that, when loaded by the persistent Main Orchestrator, it describes Runtime-owned workflow rather than authorizing local execution; Superpowers integration applies to Runtime-dispatched specialist children.
7. R-0 rejects source candidates that declare Main Orchestrator Superpowers or fail to deny any pinned Superpowers skill.
8. R-5 rejects an effective host config that exposes a Superpowers plugin, vendored Superpowers skill path, or non-denied pinned Superpowers skill to the persistent Main Orchestrator.
9. Runtime children remain exempt from this host-only process-skill isolation and retain their existing agent-specific Superpowers manifests.

## Consequences

The model-facing R-7 boundary no longer depends on the model resolving two contradictory process instructions. The first meaningful delivery transition remains the mandatory `runtime-continuation` → `agent_start` ingress, while design, planning, TDD, reviews and completion verification continue to run where they belong: inside Runtime-dispatched specialist execution.

This does not weaken SDD or remove Superpowers from the harness. It narrows Superpowers to the execution plane and makes the persistent Main Orchestrator a deterministic control-plane adapter.

A future source drift that reintroduces host Superpowers is expected to fail before the live model-facing R-7 workload, at R-0 or R-5.
