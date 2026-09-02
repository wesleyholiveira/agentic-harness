---
name: decompose-god-module
description: Split an oversized module into cohesive boundaries without silently changing behavior.
---
# Decompose god module
1. Map responsibilities, public API, side effects, state ownership and dependency direction before moving code.
2. Freeze current behavior with focused tests or contract fixtures.
3. Extract one cohesive responsibility at a time behind a compatibility façade when callers cannot migrate atomically.
4. Do not create cross-module imports of private/internal symbols; promote shared contracts deliberately.
5. Keep persistence identifiers, protocol names and externally observable behavior stable unless the approved design explicitly changes them.
6. Remove the façade only after all callers migrate and regression evidence is green.
