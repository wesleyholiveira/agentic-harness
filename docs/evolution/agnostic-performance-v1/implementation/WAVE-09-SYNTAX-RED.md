# WAVE-09 syntax RED — Docker gateway request validation

Operator-provided host test output failed before the gateway contract suite ran:

`SyntaxError: Unexpected token ')'`

Root cause: `apps/docker-gateway/server.mjs` had one extra closing parenthesis in the strict request-schema guard:

`if (JSON.stringify(keys) !== JSON.stringify(allowed) || request.schemaVersion !== 'docker-behavior-gateway-request/v1')) {`

Correction:
- remove the extra `)`;
- validate the corrected full module with `node --check`;
- add `node --check apps/docker-gateway/server.mjs` to the Docker foundation target before running contract tests.

No gateway request semantics, authorization policy, Docker permissions, Runtime behavior or consumer pin were changed.

Status: syntax RED fixed; target-host contract rerun still required.
