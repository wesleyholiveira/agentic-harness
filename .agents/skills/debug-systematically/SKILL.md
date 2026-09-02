---
name: debug-systematically
description: Diagnose failures through reproducible evidence and falsifiable hypotheses.
---
# Debug systematically
1. Reproduce with the smallest trustworthy input and preserve the exact failing evidence.
2. Separate symptom, first causal divergence and downstream noise.
3. Form one falsifiable root-cause hypothesis at a time and test it with the cheapest discriminating probe.
4. Inspect authoritative state before adding retries or fallbacks.
5. Fix the cause, add a regression contract that would have caught it earlier, then rerun neighboring invariants.
6. Stop speculative loops after the project's failure budget and report unresolved evidence explicitly.
