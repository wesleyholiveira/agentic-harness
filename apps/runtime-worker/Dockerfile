FROM rust:1.88-bookworm AS build
WORKDIR /src
COPY apps/runtime-worker ./apps/runtime-worker
RUN cargo build --locked --release --manifest-path apps/runtime-worker/Cargo.toml

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      python3 \
      python3-pip \
      python3-venv \
      python-is-python3 \
    && rm -rf /var/lib/apt/lists/* \
    && printf '%s\n' 'agentexec:x:10001:' >> /etc/group \
    && printf '%s\n' 'agentexec:x:10001:10001::/home/agentexec:/usr/sbin/nologin' >> /etc/passwd \
    && mkdir -p /home/agentexec \
    && chown 10001:10001 /home/agentexec \
    && npm install -g opencode-ai@1.18.26
WORKDIR /workspace/harness
COPY package.json ./
COPY config ./config
COPY .agents ./.agents
COPY .opencode ./.opencode
COPY scripts/internal ./scripts/internal
COPY scripts/generate-opencode-config.mjs ./scripts/generate-opencode-config.mjs
COPY vendor ./vendor
COPY apps/runtime-worker/entrypoint.sh /usr/local/bin/agentic-harness-entrypoint
COPY --from=build /src/apps/runtime-worker/target/release/agentic-harness-worker /usr/local/bin/agentic-harness-worker
ENV AGENT_HARNESS_ROOT=/workspace/harness \
    AGENT_HARNESS_PROJECT_ROOT=/workspace/repository \
    AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL=http://context-engine:8789/mcp \
    AGENT_HARNESS_CONTEXT_ENGINE_INTERNAL_URL=http://context-engine:8789/mcp
ENTRYPOINT ["agentic-harness-entrypoint"]
