#!/bin/sh
set -eu
export AGENT_HARNESS_ROOT="${AGENT_HARNESS_ROOT:-/workspace/harness}"
export AGENT_HARNESS_PROJECT_ROOT="${AGENT_HARNESS_PROJECT_ROOT:-/workspace/repository}"
export AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL="${AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL:-http://context-engine:8789/mcp}"
export AGENT_HARNESS_CONTEXT_ENGINE_INTERNAL_URL="${AGENT_HARNESS_CONTEXT_ENGINE_INTERNAL_URL:-http://context-engine:8789/mcp}"
export AGENT_HARNESS_OPENCODE_RUNTIME_CHILD=1
# Runtime-child OpenCode must not share the host-owned consumer effective config.
# The consumer project is bind-mounted from Windows/macOS/Linux host paths, while
# this worker executes in Linux with /workspace/* authorities. Keep the child
# config container-local so a later host regeneration cannot overwrite it.
export AGENT_HARNESS_OPENCODE_CONFIG_OUTPUT="${AGENT_HARNESS_OPENCODE_CONFIG_OUTPUT:-/tmp/agentic-harness/opencode.effective.json}"
export OPENCODE_CONFIG="$(node "$AGENT_HARNESS_ROOT/scripts/generate-opencode-config.mjs" | tail -n 1)"
export OPENCODE_CONFIG_DIR="$AGENT_HARNESS_ROOT/.opencode"
exec /usr/local/bin/agentic-harness-worker "$@"
