---
name: orchestrate-multi-agent-work
description: Coordinate multi-agent work using capability discovery and a runtime-compiled DAG.
---
# Orchestrate multi-agent work
1. Load distributed manifests from `.agents/agents/*/agent.json`; they describe capabilities/ownership, not a static call graph.
2. Complete Product Discovery and required impact reviews before Technical Refinement.
3. Let Technical Refinement produce the implementation plan; compile dependencies from work-item prerequisites and unresolved facts.
4. Dispatch the smallest set of specialists that owns the work; parallelize only dependency-independent items.
5. Preserve immutable acceptance criteria through Task Briefs and collect versioned Handoff Results.
6. Require QA, conditional operational readiness and Product Acceptance before closure.
