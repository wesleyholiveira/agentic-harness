# Dedicated test target for these host-controller libraries, not a product runtime.
# Mirrors the Node 22 family used by the existing Context Engine image. Pin the
# resolved image ID when running; the mutable tag itself is not an evidence ID.
FROM node:22-alpine AS toolchain
RUN apk add --no-cache git
WORKDIR /workspace/harness
COPY --chown=node:node packages/harness-contracts/src/ packages/harness-contracts/src/
COPY --chown=node:node packages/source-identity/src/ packages/source-identity/src/
COPY --chown=node:node packages/source-identity/bin/ packages/source-identity/bin/
COPY --chown=node:node scripts/internal/source-manifest.mjs scripts/internal/source-manifest.mjs
COPY --chown=node:node tests/contracts/portable-contracts.test.mjs tests/contracts/portable-contracts.test.mjs
COPY --chown=node:node tests/contracts/source-identity-v2.test.mjs tests/contracts/source-identity-v2.test.mjs
USER node
FROM toolchain AS test
CMD ["sh", "-ec", "node --version; git --version; id; node --test tests/contracts/portable-contracts.test.mjs tests/contracts/source-identity-v2.test.mjs"]
