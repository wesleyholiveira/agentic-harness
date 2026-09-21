# WAVE-07 Docker RED — incomplete integrated build context

Operator-provided Docker test log reported:

- tests: 205
- pass: 203
- fail: 2
- skipped: 0
- duration: 3862.999422 ms

The visible root cause is ESM resolution failure:

`ERR_MODULE_NOT_FOUND: /workspace/harness/.agents/runtime/validation-command.mjs`

The package-local Docker target copied `packages/**`, selected scripts and test
files, but WAVE-06/WAVE-07 integrated tests import active Runtime planning modules
and schemas. The image therefore lacked committed `.agents/runtime/**` and
`.agents/schemas/**` even though the same tests could pass on the host checkout.

Correction:
- Dockerfile now copies `.agents/runtime/**` and `.agents/schemas/**`;
- documented git-archive build context now includes those same committed paths;
- no production runtime/admission/executor semantics were changed.

Evidence status: Docker RED diagnosed and packaging corrected; target Docker rerun
is REQUIRED. Do not mark this target GREEN from the previous log.
