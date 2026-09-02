---
name: change-web-ui
description: Implement or review frontend/UI changes in React, Vue, Angular or other web clients.
---
# Change web UI
1. Locate the consuming project's frontend entrypoint, state owner, component boundary and test strategy.
2. Keep server state, client state and ephemeral UI state owned by one clear layer each.
3. Extract testable calculations and transformations from rendering code.
4. Preserve accessibility, keyboard behavior, responsive layouts, loading/error/empty states and hydration/SSR constraints when applicable.
5. Prefer existing design-system primitives and tokens over parallel ad-hoc components.
6. Run focused unit/component/e2e checks appropriate to the change.
