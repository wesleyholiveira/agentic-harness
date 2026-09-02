---
name: ddd-split-app
description: Map and split an application/module/service by bounded context and operational ownership. Use before any app/module/service split; prefer cohesive modules before services.
---

# ddd-split-app

Before changing boundaries, produce and persist the following ten artifacts in the active ExecPlan or Context Packet:

1. Responsibility Inventory.
2. Domain Map.
3. Bounded Context Map.
4. Coupling Analysis.
5. Module-vs-Service Decision.
6. Ports/Adapters.
7. Data Ownership.
8. Events/Commands.
9. Migration DAG.
10. Performance + Failure Model.

Rules:

- Never split a god file into arbitrary `part1`/`part2` modules. Extract coherent responsibilities.
- Prefer modules first. A service split requires an operational reason: independent scaling, failure/resource/security boundary, independent deployment/data ownership, or materially different runtime needs.
- Do not create a distributed monolith. Cross-service contracts must be explicit and versioned.
- One bounded context owns writes to its aggregates. Other contexts use ports/events/commands.
- Prefer asynchronous communication when the caller does not require a synchronous result.
- Preserve public façade/import compatibility during structural extraction when practical.
- Record data migration, rollback/recovery compatibility, idempotency/fencing and failure behavior before implementation.
- Apply the consuming project standards and `enforce-code-quality-standards`; structural extraction must not silently change domain behavior.
