# ADR 0039 — Criterion verification command boundary

Status: accepted

## Context

Product acceptance criteria carry a required `verification` string. That field is product evidence guidance and may be either an executable command (for example `npm test`) or descriptive prose (for example `Test file is present and npm test executes successfully.`).

The Runtime previously classified validation commands from the first token alone. Because POSIX `test` is also an ordinary English word, descriptive verification prose beginning with `Test` could be classified as an executable command. Technical Refinement would then require the entire prose sentence byte-for-byte in `workItems[*].validation`, even when the actual executable validation was already `npm test`. This created a false `implementation_plan_criterion_verification_missing` gate and could exhaust the Technical Refinement retry budget.

## Decision

`criterion.verification` is not executable authority merely because it mentions an executable. The Runtime treats a criterion verification as an executable command only when the entire value is accepted by the validation-command contract.

Direct POSIX `test` is removed from the validation executable allowlist and structured-output command pattern because it is inherently ambiguous with natural-language verification. A validation that needs POSIX `test` must use an explicit shell wrapper such as `bash -lc "test -f package.json"` or `sh -lc "test -f package.json"`.

`npm test` and other unambiguous command-shaped values remain executable authority and, when used directly as an implementation criterion verification, must still be preserved byte-for-byte in the claiming work item's validation.

Technical Refinement prompts explicitly distinguish descriptive criterion verification from command-shaped criterion verification. They must never copy prose into `workItems[*].validation` merely because that prose mentions a command.

## Consequences

- Descriptive product verification remains legitimate and immutable Product Owner authority.
- Machine-executable validation remains a separate, narrower authority.
- The DAG validator no longer converts `Test ... npm test ...` prose into an exact-command requirement.
- Direct POSIX `test` requires an explicit `bash -lc` or `sh -lc` wrapper.
- Real executable criterion verification such as `npm test` remains fail-closed and byte-exact.
