# ADR 0135 — Integrated Agent Runtime V2 architecture reference and documentation contract

**Status:** accepted as documentation governance for the R17.4.3 source candidate

**Implementation evidence:** [`../operations/snapshots/agent-runtime-v2-r17-4-3-integrated-architecture-documentation-20260829.md`](../operations/snapshots/agent-runtime-v2-r17-4-3-integrated-architecture-documentation-20260829.md)

## Context

The Agent Runtime V2 architecture evolved through many independently reviewed ADRs, specs, runbooks, schemas and implementation contracts. That decomposition is appropriate for durable decisions, but it made the current system difficult to learn as one coherent runtime:

- the same word could refer to a product workflow object or an agent-runtime object;
- `Context Pack`, `Context Packet` and `AgentInputManifest/v1` were often conflated;
- semantic attempt, physical generation, fencing and retry were documented in separate recovery revisions;
- the deterministic/compiler boundary, primary LLM boundary and auxiliary-model boundary were not explained together;
- the Rust binary hosts multiple subcommands whose shared process location can be mistaken for shared authority;
- PostgreSQL/Redis authority could be confused with mutable state internally owned by the external OpenCode process;
- context, Runtime-owned input and provider-token accounting were correctly non-additive but hard to compare without a common map.

Relying on chat history or asking an LLM to infer ADR filenames and object relations is not a durable architectural interface. At the same time, creating another normative specification that duplicates every ADR would introduce a competing authority and drift.

## Decision

1. Maintain an integrated explanatory reference under:

   `docs/architecture/agent-runtime-v2/`

2. The reference is organized by concern:

   - overview and reading path;
   - object model and nomenclature;
   - DAG/lifecycle steps;
   - deterministic/LLM/OpenCode boundaries;
   - planes, workers and write ownership;
   - context, caches and persistence;
   - failure, retry, process-loss and continuation;
   - observability, performance and qualification;
   - end-to-end examples and sequence diagrams;
   - source/test map and maintenance checklist.

3. The integrated reference is **not** a new behavioral authority. Precedence remains:

   1. accepted/promoted ADR applicable to the boundary;
   2. versioned JSON Schema;
   3. implemented source and executable contract tests;
   4. PRD/DESIGN/TEST-PLAN and qualification runbook;
   5. integrated reference as explanatory map.

   A detected divergence must be reconciled; readers and agents must not silently choose whichever document is convenient.

4. Canonical indexes (`docs/README.md`, `docs/agents/README.md`, system/observability overviews and repository map) link to the integrated reference. `AGENTS.md` keeps only a concise pointer and does not absorb the manual.

5. Add `scripts/agent-runtime-v2-architecture-documentation-contract.test.mjs` and the npm command `test:agent-runtime-v2-architecture-docs`. The contract verifies presence, cross-linking and critical distinctions, including:

   - Task Brief versus Context Packet versus Agent Input Manifest versus Handoff;
   - semantic attempt versus physical generation;
   - deterministic reuse versus cache hit;
   - sessionless progress versus terminal continuation;
   - PostgreSQL/Redis Runtime authority versus external OpenCode mutable state;
   - non-additive Runtime/context/provider accounting;
   - R16/R16.1 promoted status and R17.4.3 candidate status.

6. Every future structural Runtime change updates the applicable chapter and `SOURCE-MAP.md` in the same diff. The documentation test joins the focused/aggregate Runtime gates, but does not replace typecheck, Context Engine, Rust/Cargo, live readiness or fresh qualification evidence.

## Consequences

- Engineers and agents gain one navigable learning surface without flattening the underlying authorities.
- New workers, caches, events, stages, schemas or model boundaries have an explicit documentation checklist.
- Common terminology mistakes become testable documentation regressions.
- The documentation delta changes tracked source and therefore requires a fresh source fingerprint for any subsequent R17.4.3 qualification chain.
- Existing historical ADRs remain historical records; active refinements are called out instead of rewriting their original context.

## Alternatives rejected

### Keep knowledge only in ADRs and runbooks

Rejected because it preserves decision history but does not provide an end-to-end operating model or object glossary.

### Put the complete manual in `AGENTS.md`

Rejected because every agent would pay the context cost on every task and the global instruction file would stop being a concise routing/guardrail surface.

### Treat the integrated manual as the highest authority

Rejected because explanatory prose cannot safely supersede schemas, source and executable contracts.

### Generate the manual only during qualification

Rejected because operators and contributors need it before a run and because generated-only documentation would not participate in normal review/versioning.

## Review criteria

Review this decision when one of the following becomes true:

- Runtime objects are generated into a reliable machine-readable catalog from schemas/source;
- a documentation compiler can derive diagrams and source maps without losing semantic explanations;
- the Runtime is replaced by a materially different control/execution architecture;
- the integrated reference becomes large enough that measured retrieval shows it harms rather than improves task context.
