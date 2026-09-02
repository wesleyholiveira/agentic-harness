# ADR 0124 — R17 Deterministic-Reuse Qualification Fixture and Auxiliary Model-Time Attribution

- Status: Accepted for R17.1 qualification
- Date: 2026-08-28
- Parent: ADR 0123

## Context

The first fresh R17 qualification passed R-0 through H-8 but failed H-9P in Technical Refinement. R17 reused the historical R15.5 revision-5 qualification PRD as the deterministic-reuse candidate. That PRD is immutable Product Owner authority and contains multiple blocking criteria with `proofStage=implementation` whose `verification` fields are descriptive prose. ADR 0123 intentionally requires deterministic reuse to have executable criterion proof. The compiler therefore rejected every plan that preserved the Product Owner catalog, while mutating those criteria would violate upstream authority.

The same run also exposed an attribution ambiguity: bounded structured-model plan repair/projection executes after the primary specialist OpenCode call and was therefore included in `runtimeAfterOpenCodeMs`, making LLM work look like Runtime wrapper overhead.

## Decision

1. **Do not relax deterministic-reuse admission.** A blocking implementation criterion remains ineligible when its authoritative verification is non-executable.
2. **Do not mutate historical Product Owner criteria.** The R15.5 marker remains valid for its original qualification purpose and is not rewritten to serve R17.
3. Introduce a **purpose-built pre-materialized R17.1 qualification fixture** at `docs/specs/agent-runtime-v2-r17-deterministic-reuse-qualification/PRD.md`.
4. That fixture emits exactly one `proofStage=implementation` criterion, `R17-REUSE-1`, with byte-exact executable verification `npm run test:agent-runtime-r17-deterministic-reuse-fixture`. Topology and in-run source-attribution criteria use downstream QA proof stages. ADR 0125 later moves final source identity/performance/run-global input-plane proof fully to the outer controller.
5. H-9P Technical Refinement must produce exactly one deterministic-reuse work item covering only `R17-REUSE-1`; the Runtime proves manifest identity, exact bytes and the focused validation without OpenCode/model invocation.
6. Runtime-owned structured-output invocations record `wallMs`. Finalization persists a bounded auxiliary timing projection. `runtime-performance/v1` derives:
   - `openCodeMs`: primary specialist OpenCode wall-clock;
   - `auxiliaryModelMs`: successful bounded structured-model projection/repair wall-clock;
   - `modelToolLoopMs = openCodeMs + auxiliaryModelMs`;
   - `runtimeAfterOpenCodeExclusiveMs`: post-primary executor time excluding measured auxiliary model time;
   - `runtimeWrapperExclusiveMs`: pre-primary wrapper + exclusive post-primary wrapper.
7. If an auxiliary model invocation is declared but timing is unavailable, performance evidence is `INCOMPLETE`; it is never silently counted as zero.

## Consequences

- Product Owner authority remains immutable.
- The deterministic-reuse compiler stays fail-closed.
- The H-9P workload now exercises a configuration the no-LLM executor can actually prove.
- R17 latency reports no longer blame bounded Technical Plan repair/projection wall-clock on the Runtime wrapper.
- Because source changed after the failed R17 chain, R17.1 requires a fresh byte-consistent `R-0 → R-1 → R-2 → R-2P → H-8 → H-9P → H-9R` qualification.
