# ADR 0035 — Isolate R-9 worker-loss recovery from downstream semantic workload drift

Status: accepted

## Context

R-9 qualifies physical loss of the Rust worker during an exact Technical Refinement repair checkpoint. The previous R-9 semantic workload added `formatInitials(name)` by editing `src/format-name.mjs`, a file whose `formatName(name)` behavior had already been changed and accepted by R-7. A later qualification proved the worker-loss replacement path but the run eventually failed in QA because the implementation regressed the established empty-input behavior of `formatName`. The gate reported `r9_run_not_closed_after_worker_loss`, conflating a successful process-loss recovery with an unrelated downstream semantic regression.

## Decision

R-9 uses a dedicated additive qualification PRD. `formatInitials(name)` is implemented in a new `src/format-initials.mjs` module with its own `test/format-initials.test.mjs`. `src/format-name.mjs` and `test/format-name.test.mjs` are immutable R-9 baseline invariants measured by SHA-256 before the semantic run and verified again after the run closes.

The qualification controller evaluates the authoritative worker-loss replacement evidence as soon as the replacement receipt is available, before requiring the whole semantic run to close. A downstream semantic failure after valid recovery remains a HOLD, but it is classified as `r9_post_recovery_semantic_run_failed` and includes the proven recovery evidence. A successful run additionally proves that the established format-name files were not mutated and that the isolated initials source/test artifacts exist.

## Consequences

- R-9 still requires a closed semantic run; QA failures are never converted to PASS.
- Physical worker-loss recovery and downstream workload quality have distinct evidence and failure classifications.
- The R-9 implementation slice cannot legitimately rewrite behavior established by R-7.
- R-10 can continue to run only after R-9 has closed and validated the additive consumer state.
