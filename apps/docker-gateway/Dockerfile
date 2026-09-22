FROM docker:27.5.1-cli AS docker-cli

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /workspace/harness
RUN npm install --omit=dev --no-save pg@8.22.0
COPY packages ./packages
COPY apps/docker-gateway ./apps/docker-gateway
ENV AGENT_HARNESS_PROJECT_ROOT=/workspace/repository \
    AGENT_HARNESS_AGENT_WORKSPACE_ROOT=/workspace/agent-workspaces \
    AGENT_HARNESS_DOCKER_GATEWAY_PORT=8792
CMD ["node","apps/docker-gateway/server.mjs"]
