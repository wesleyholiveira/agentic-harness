# ADR 0041 — Bounded Product Discovery bootstrap-assessment repair before task retry

Status: Accepted

## Context

A real consuming-project Runtime V2 run reached Product Discovery with healthy execution infrastructure but failed all three Product Owner attempts on the same bootstrap-facts/v1 envelope mistake. The model populated `factRequirements[*].source` with repository locators such as semicolon-separated file paths and Markdown anchors. The contract requires `source` to be one semantic authority label while concrete repository references belong in `evidence`.

The harness already contained `projectMissingProductDiscoveryBootstrapAssessment()`, including a narrowed projection schema whose source field is the authoritative-source enum, but the executor did not invoke that bounded repair before the generic Handoff schema/completion gates. Consequently a mechanically repairable envelope error consumed full Product Owner retries and prevented Technical Refinement from dispatching.

## Decision

1. Product Discovery Handoffs are passed through the bounded bootstrap-assessment repair before the generic Handoff schema gate and before stage completion.
2. Missing or semantically invalid assessments may be repaired in the same task attempt by `projectMissingProductDiscoveryBootstrapAssessment()`.
3. Plain semicolon/newline-separated repository paths may be deterministically canonicalized to `repository-context` only when every referenced path is already authorized by the Context Packet.
4. A source containing a Markdown anchor is never deterministically canonicalized. It must pass through the bounded projection so an invented heading/section is not silently legitimized.
5. `handoff-result.schema.json` closes bootstrap fact `source` to exactly `product-discovery`, `frozen-adr`, `project-memory`, or `repository-context`.
6. Product Owner instructions explicitly require paths, filenames, anchors, and excerpts to be placed in `evidence`, not `source`.
7. The executor persists an explicit `product_discovery.bootstrap_assessment_repaired` event when deterministic or model-bounded repair changes the assessment.
8. Only repair failure proceeds to the existing task-retry policy; the Runtime does not weaken semantic validation or auto-approve Product Discovery.

## Consequences

- Repeated schema-envelope mistakes no longer need to consume the full Product Owner retry budget.
- The bootstrap-facts/v1 authority taxonomy remains strict.
- Repository anchors are not trusted merely because their base path exists.
- Downstream Technical Refinement remains blocked until Product Discovery produces a valid, evidence-backed assessment.
