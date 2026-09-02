# ADR 0122 — Focused implementation validation authority

## Status

Promoted with R16/R16.1 on 2026-08-28. See [`../operations/snapshots/agent-runtime-v2-r16-r16-1-promotion-20260828.md`](../operations/snapshots/agent-runtime-v2-r16-r16-1-promotion-20260828.md).

## Context

R16 promotion passed R-0, R-1, R-2, R-2P and H-8, then failed H-9 in `run-00cf7099-674d-4e0e-a63b-867999470d15`. The immutable marker implementation task exhausted its retry budget because an ad-hoc `node -e` validation failed. The R16 H-9 request had accidentally dropped the R15.6.x clause that explicitly required `npm run test:agent-runtime-r15-5-qualification-fixture` as the focused marker validation.

The Runtime was still fail-closed, but too late. Technical Plan preflight validated executable shape, workspace scope, owner/path legality, criterion coverage and DAG acyclicity without binding a request-explicit focused validation command to `workItems[*].validation`. A Technical Lead could therefore replace the requested proof with another executable command, and the mismatch consumed implementation attempts before the completion gate rejected it.

## Decision

### 1. Focused request validation is structural authority

When the request uses `validação focada` / `focused validation` immediately followed by executable inline-code commands, the Runtime derives a focused implementation-validation directive.

The parser is intentionally narrow. Other code spans do not become hidden Runtime gates.

### 2. Focused commands are byte-exact and exclusive

For a focused directive:

- every declared command must appear in implementation `workItems[*].validation` byte-for-byte;
- substitute or additional implementation validation commands are invalid;
- validation remains `workspace` scoped;
- downstream QA/readiness retain their independent evidence responsibilities.

This means the R16 qualification marker work item must use exactly:

`npm run test:agent-runtime-r15-5-qualification-fixture`

and cannot replace it with an ad-hoc `node -e` equivalent.

### 3. Executable Product verification is preserved

Independently of focused mode, if an implementation Product criterion already carries an executable shell command in `criterion.verification`, every work item claiming that criterion must include that exact command. Prose verification remains prose and is not converted into a shell gate.

### 4. Reject/repair before implementation dispatch

The deterministic Technical Plan issue vector now includes focused-validation missing/extra and executable-criterion verification drift. `synthesizeMissingImplementationPlan` receives the same directive and may repair the implementation plan within the bounded Technical Refinement repair loop. A bad proof plan therefore does not need to consume a new implementation task attempt.

The final compiler repeats the same check against `plan.request`; repair is not trusted by assertion.

### 5. Restore the R16 qualification workload

The R16 H-9/H-9R exact immutable workload again explicitly states the focused marker validation. H-9 additionally requires the compiled marker implementation Task Brief to contain that command with no substitute/extra implementation validation.

## Consequences

- The Runtime remains fail-closed, but validation-authority drift is caught at Technical Plan preflight instead of implementation completion.
- The revision-5 immutable marker fixture remains byte-identical; this ADR changes Runtime planning/qualification authority, not the marker.
- An LLM may still propose additional validation when no focused directive exists, subject to existing scope and criterion rules.
- Request text does not generally become executable authority; only the explicit focused-validation syntax does.
- Because this source change follows a failed promotion H-9, all previous R16 gate evidence becomes historical and the next promotion must restart from R-0.

## Supersession / compatibility

ADR 0122 augments ADR 0121 and the promoted R15.6.12 validation/retry contracts. It does not change AgentInputManifest identity, lazy-artifact authorization, progress/continuation semantics, fencing, process-loss repair, Clip Learning V2 or model routing.
