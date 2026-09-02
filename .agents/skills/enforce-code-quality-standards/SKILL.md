---
name: enforce-code-quality-standards
description: Apply project-local engineering standards before and after implementation changes.
---
# Enforce code quality standards
1. Read the nearest `AGENTS.md`, project lint/type/test configuration and applicable ADRs before editing.
2. Prefer small cohesive modules, explicit ownership, dependency inversion at external boundaries and simple control flow.
3. Avoid duplicated authority, hidden global state, speculative abstraction, silent fallback and unbounded retry.
4. Preserve typed errors/contracts and structured observability at important boundaries.
5. Follow the consuming project's language conventions and formatter/linter; do not impose a foreign stack style.
6. Run focused tests during RED → GREEN → REFACTOR, then the acceptance validation required by the Task Brief.
7. Report code-quality status as `compliant`, `debt-registered`, or `violated`; `violated` blocks completion.
