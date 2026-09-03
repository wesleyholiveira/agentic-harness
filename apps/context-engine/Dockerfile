FROM node:22-alpine
WORKDIR /workspace/harness
COPY package.json package-lock.json tsconfig.json ./
COPY apps/context-engine ./apps/context-engine
COPY packages ./packages
COPY .agents ./.agents
COPY infra ./infra
COPY scripts/internal ./scripts/internal
COPY scripts/harness-migrate.mjs ./scripts/harness-migrate.mjs
RUN npm ci
RUN ./node_modules/.bin/codebase-memory-mcp --version
ENV AGENT_HARNESS_ROOT=/workspace/harness \
    AGENT_HARNESS_PROJECT_ROOT=/workspace/repository
CMD ["npx","tsx","apps/context-engine/src/http.ts"]
