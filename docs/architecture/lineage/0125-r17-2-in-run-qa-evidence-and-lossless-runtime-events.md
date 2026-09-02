# ADR 0125 — R17.2 In-Run QA Evidence Closure and Lossless Runtime Event Capture

- Status: Accepted for R17.2 qualification
- Date: 2026-08-28
- Parent: ADR 0124

## Context

The fresh R17.1 qualification passed R-0 through H-8 and successfully exercised the new deterministic-reuse path: the marker completed in 13.297 seconds with zero OpenCode/model invocation, zero model tokens, `changedPaths=[]` and byte-identical reuse. H-9P nevertheless stopped in Quality Assurance.

The failure exposed two authority mismatches in the qualification design rather than a deterministic-reuse defect:

1. R16 `AgentInputManifest/v1` intentionally projects **direct dependency** handoffs. The compiled QA task depended on Technical Refinement plus implementation tasks, while `R17-TOPOLOGY-1` asked QA to inspect Product Discovery/bootstrap-review authority. Those producers were transitive ancestors but not direct QA dependencies, so their projections/lazy refs were not guaranteed to be present in the QA manifest.
2. The R17.1 fixture assigned `R17-SOURCE-1` to `quality-assurance` while its verification required R-0/pre-run/**post-cleanup** manifests. Post-cleanup evidence cannot exist during an in-run QA task. The fixture also carried final performance/run-global input-plane expectations that are complete only after the terminal run and therefore belong to the outer qualification controller, not to Product Owner acceptance criteria inside the run.

The same H-9P returned `runtime-performance/v1` as `INCOMPLETE` because three full-agent attempts lacked the inner OpenCode boundary. Rust drained child stdout and stderr concurrently and captured `@@agentic-harness-runtime-event` records with `try_lock()`. Contention could silently discard an otherwise valid timing event, which is incompatible with fail-closed performance evidence.

## Decision

1. **Do not weaken QA or the R16 manifest boundary.** QA receives bootstrap authority by explicit DAG dependency, not by unrestricted run-wide lookup.
2. Compiled QA tasks depend directly on Product Discovery and every selected bootstrap review in addition to Technical Refinement and implementation tasks. These extra edges do not lengthen the critical path because those tasks are already ancestors of Technical Refinement. Their purpose is evidence delivery: R16 can now include bounded handoff projections and manifest-authorized lazy refs in QA input.
3. QA must use the manifest-attached direct-dependency evidence projection, `Task Brief.changeProvenance`, and manifest-listed lazy refs. It must not block on a non-dependency handoff, an unlisted whole-run artifact, or outer-controller R-0/post-cleanup evidence.
4. Revise the purpose-built qualification fixture to revision 2. Its in-run Product Owner catalog contains only:
   - `R17-REUSE-1` — implementation proof by exact executable validation;
   - `R17-TOPOLOGY-1` — independent QA proof from direct bootstrap projections + refined DAG;
   - `R17-SOURCE-1` — independent QA proof that the in-run implementation/reuse increment attributes no tracked-source mutation via `Task Brief.changeProvenance`.
5. Final R-0→post-cleanup source identity, final run-wall SLO/performance verdict, and run-global R16 input-plane/accounting evidence remain mandatory **outer-controller gates**. They are intentionally not in-run Product Owner criteria because complete evidence does not exist before terminal Product Acceptance.
6. Rust runtime-event buffering becomes lossless under local stream contention: `observe_runtime_event` awaits the shared bounded buffers instead of using `try_lock()`. The buffer remains capped at 256 events and is read only after stdout/stderr drain tasks finish.
7. Missing OpenCode timing remains fail-closed (`INCOMPLETE`). R17.2 fixes the capture path; it does not reinterpret missing evidence as zero or widen the SLO.

## Consequences

- Deterministic reuse remains unchanged and fail-closed.
- QA gets exactly the upstream authority its assigned criteria require while preserving the R16 manifest-only input plane.
- No in-run agent is asked to prove evidence that can only exist after the run terminates.
- Performance qualification remains an outer, independent gate and cannot be self-certified by Product Acceptance.
- Runtime timing boundaries cannot be silently lost because stdout/stderr happened to contend for the same mutex.
- Source changed after the R17.1 HOLD, so R17.2 requires a fresh byte-consistent `R-0 → R-1 → R-2 → R-2P → H-8 → H-9P → H-9R` chain.
