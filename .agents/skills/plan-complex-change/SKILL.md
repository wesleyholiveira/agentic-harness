---
name: plan-complex-change
description: Produce a bounded implementation plan/ExecPlan for cross-module features, migrations or refactors.
---
# Plan complex change
1. Start from an approved PRD and architecture decisions; do not invent product requirements.
2. Materialize `docs/templates/IMPLEMENTATION-PLAN.md` or the machine-readable implementation-plan schema.
3. Split work into independently ownable items with exact paths, dependencies, acceptance-criterion IDs and executable validation.
4. Keep runtime/host validation out of workspace-local implementation commands unless the criterion explicitly requires it.
5. Model dependency edges from real data/contract prerequisites, not from a static specialist order.
6. Update the plan when evidence changes scope; preserve decision history rather than silently rewriting it.
