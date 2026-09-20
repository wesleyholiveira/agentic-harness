# Foundation-library target, NOT a product runtime/toolchain assertion.
FROM node:22-alpine AS toolchain
RUN apk add --no-cache git
WORKDIR /workspace/harness
COPY --chown=node:node packages/harness-contracts/src/ packages/harness-contracts/src/
COPY --chown=node:node packages/source-identity/src/ packages/source-identity/src/
COPY --chown=node:node packages/source-identity/bin/ packages/source-identity/bin/
COPY --chown=node:node packages/project-adapters/src/ packages/project-adapters/src/
COPY --chown=node:node packages/project-adapters/bin/ packages/project-adapters/bin/
COPY --chown=node:node scripts/internal/source-manifest.mjs scripts/internal/source-manifest.mjs
COPY --chown=node:node tests/contracts/portable-contracts.test.mjs tests/contracts/portable-contracts.test.mjs
COPY --chown=node:node tests/contracts/source-identity-v2.test.mjs tests/contracts/source-identity-v2.test.mjs
COPY --chown=node:node tests/contracts/project-descriptor.test.mjs tests/contracts/project-descriptor.test.mjs
USER node
FROM toolchain AS test
CMD ["sh", "-ec", "node --version; git --version; id; node --test tests/contracts/portable-contracts.test.mjs tests/contracts/source-identity-v2.test.mjs tests/contracts/project-descriptor.test.mjs"]
