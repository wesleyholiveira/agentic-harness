# Foundation-library target, NOT a product runtime/toolchain assertion.
FROM node:22-alpine AS toolchain
RUN apk add --no-cache git
WORKDIR /workspace/harness
COPY --chown=node:node packages/harness-contracts/src/ packages/harness-contracts/src/
COPY --chown=node:node packages/source-identity/src/ packages/source-identity/src/
COPY --chown=node:node packages/source-identity/bin/ packages/source-identity/bin/
COPY --chown=node:node packages/project-adapters/src/ packages/project-adapters/src/
COPY --chown=node:node packages/project-adapters/bin/ packages/project-adapters/bin/
COPY --chown=node:node apps/docker-gateway/ apps/docker-gateway/
COPY --chown=node:node apps/runtime-worker/src/ apps/runtime-worker/src/
COPY --chown=node:node apps/runtime-worker/Cargo.toml apps/runtime-worker/Cargo.toml
COPY --chown=node:node apps/runtime-worker/Cargo.lock apps/runtime-worker/Cargo.lock
COPY --chown=node:node apps/runtime-worker/entrypoint.sh apps/runtime-worker/entrypoint.sh
COPY --chown=node:node apps/runtime-worker/Dockerfile apps/runtime-worker/Dockerfile
COPY --chown=node:node .env.example .env.example
COPY --chown=node:node compose.yaml compose.yaml
COPY --chown=node:node .agents/runtime/ .agents/runtime/
COPY --chown=node:node .agents/schemas/ .agents/schemas/
COPY --chown=node:node scripts/internal/source-manifest.mjs scripts/internal/source-manifest.mjs
COPY --chown=node:node scripts/qualification/wave10-live-preflight.mjs scripts/qualification/wave10-live-preflight.mjs
COPY --chown=node:node scripts/qualification/wave10-fault-preflight.mjs scripts/qualification/wave10-fault-preflight.mjs
COPY --chown=node:node scripts/qualification/lib/fixture.mjs scripts/qualification/lib/fixture.mjs
COPY --chown=node:node scripts/qualification/lib/process.mjs scripts/qualification/lib/process.mjs
COPY --chown=node:node scripts/qualification/lib/source-attested-behavior.mjs scripts/qualification/lib/source-attested-behavior.mjs
COPY --chown=node:node scripts/qualification/lib/util.mjs scripts/qualification/lib/util.mjs
COPY --chown=node:node tests/contracts/portable-contracts.test.mjs tests/contracts/portable-contracts.test.mjs
COPY --chown=node:node tests/contracts/source-identity-v2.test.mjs tests/contracts/source-identity-v2.test.mjs
COPY --chown=node:node tests/contracts/project-descriptor.test.mjs tests/contracts/project-descriptor.test.mjs
COPY --chown=node:node tests/contracts/command-admission-v2.test.mjs tests/contracts/command-admission-v2.test.mjs
COPY --chown=node:node tests/contracts/trusted-project-config-v2.test.mjs tests/contracts/trusted-project-config-v2.test.mjs
COPY --chown=node:node tests/contracts/command-readiness-v2.test.mjs tests/contracts/command-readiness-v2.test.mjs
COPY --chown=node:node tests/contracts/validation-command-authority-v2.test.mjs tests/contracts/validation-command-authority-v2.test.mjs
COPY --chown=node:node tests/contracts/command-spec-execution-v2.test.mjs tests/contracts/command-spec-execution-v2.test.mjs
COPY --chown=node:node tests/contracts/behavior-fence-attestation-v2.test.mjs tests/contracts/behavior-fence-attestation-v2.test.mjs
COPY --chown=node:node tests/contracts/docker-behavior-gateway-v1.test.mjs tests/contracts/docker-behavior-gateway-v1.test.mjs
COPY --chown=node:node tests/contracts/runtime-regressions.test.mjs tests/contracts/runtime-regressions.test.mjs
COPY --chown=node:node tests/contracts/wave10-live-preflight.test.mjs tests/contracts/wave10-live-preflight.test.mjs
COPY --chown=node:node tests/contracts/wave10-fault-preflight.test.mjs tests/contracts/wave10-fault-preflight.test.mjs
USER node
FROM toolchain AS test
CMD ["sh", "-ec", "node --version; git --version; id; node --check apps/docker-gateway/server.mjs; node --check apps/docker-gateway/fence-store.mjs; node --test tests/contracts/portable-contracts.test.mjs tests/contracts/source-identity-v2.test.mjs tests/contracts/project-descriptor.test.mjs tests/contracts/command-admission-v2.test.mjs tests/contracts/trusted-project-config-v2.test.mjs tests/contracts/command-readiness-v2.test.mjs tests/contracts/validation-command-authority-v2.test.mjs tests/contracts/command-spec-execution-v2.test.mjs tests/contracts/behavior-fence-attestation-v2.test.mjs tests/contracts/docker-behavior-gateway-v1.test.mjs tests/contracts/runtime-regressions.test.mjs tests/contracts/wave10-live-preflight.test.mjs tests/contracts/wave10-fault-preflight.test.mjs"]
