# Execution Plan — Product Discovery bootstrap source repair

Date: 2026-09-19
Status: implemented candidate

## Failure reproduced

The failing run repeatedly emitted repository locators in `bootstrapReviewAssessment.factRequirements[*].source`, while bootstrap-facts/v1 accepts only semantic authority labels. Technical Refinement never dispatched because Product Discovery exhausted its retry budget.

## Implementation

- Wire `projectMissingProductDiscoveryBootstrapAssessment()` into executor post-processing before the generic Handoff schema gate.
- Close the bootstrap source field in the Handoff schema.
- Canonicalize only plain authorized repository path lists; anchored locators require bounded semantic projection.
- Strengthen Product Owner and projection prompts.
- Add regression tests for:
  - semicolon-separated authorized paths;
  - invented/noncanonical Markdown anchors;
  - strict projection source enum;
  - executor repair ordering before schema/completion gates.

## Validation

```bash
node --test tests/contracts/product-discovery-bootstrap-source-repair.test.mjs
node --test tests/contracts/agent-start-session-authority.test.mjs
node --test tests/contracts/agent-start-current-user-message-authority.test.mjs
npm run harness:test
node scripts/internal/source-manifest.mjs --check
npm run harness:qualify
```

A fresh Runtime run against the consuming project request is required after promotion to prove Product Discovery no longer exhausts retries on this envelope class.
