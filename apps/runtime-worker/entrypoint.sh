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

# Every model-controlled agent runs as uid 10001 after the Rust worker has
# prepared the task. It needs the Context Engine MCP and public model/provider
# endpoints, but
# they must not share control-plane access to PostgreSQL, RabbitMQ, Redis, the
# Docker gateway, or host-published service ports. Install a UID-scoped egress
# chain before starting the worker, then drop NET_ADMIN from the worker itself.
configure_agentexec_network_guard() {
  command -v iptables >/dev/null 2>&1 || {
    echo "agentexec_network_guard_missing_iptables" >&2
    exit 78
  }
  command -v setpriv >/dev/null 2>&1 || {
    echo "agentexec_network_guard_missing_setpriv" >&2
    exit 78
  }

  context_ipv4=""
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    context_ipv4="$(getent ahostsv4 context-engine 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
    [ -n "$context_ipv4" ] && break
    attempt=$((attempt + 1))
    sleep 0.25
  done
  [ -n "$context_ipv4" ] || {
    echo "agentexec_network_guard_context_engine_unresolved" >&2
    exit 78
  }

  chain="AH_AGENTEXEC_EGRESS"
  iptables -w 5 -N "$chain" 2>/dev/null || true
  iptables -w 5 -F "$chain"
  iptables -w 5 -C OUTPUT -m owner --uid-owner 10001 -j "$chain" 2>/dev/null \
    || iptables -w 5 -I OUTPUT 1 -m owner --uid-owner 10001 -j "$chain"
  iptables -w 5 -A "$chain" -o lo -j RETURN
  for ip in $context_ipv4; do
    iptables -w 5 -A "$chain" -d "$ip/32" -p tcp --dport 8789 -j RETURN
  done
  for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
    iptables -w 5 -A "$chain" -d "$cidr" -j REJECT
  done
  iptables -w 5 -A "$chain" -j RETURN

  if command -v ip6tables >/dev/null 2>&1 && ip6tables -w 5 -L OUTPUT >/dev/null 2>&1; then
    context_ipv6="$(getent ahostsv6 context-engine 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
    chain6="AH_AGENTEXEC_EGRESS6"
    ip6tables -w 5 -N "$chain6" 2>/dev/null || true
    ip6tables -w 5 -F "$chain6"
    ip6tables -w 5 -C OUTPUT -m owner --uid-owner 10001 -j "$chain6" 2>/dev/null \
      || ip6tables -w 5 -I OUTPUT 1 -m owner --uid-owner 10001 -j "$chain6"
    ip6tables -w 5 -A "$chain6" -o lo -j RETURN
    for ip in $context_ipv6; do
      ip6tables -w 5 -A "$chain6" -d "$ip/128" -p tcp --dport 8789 -j RETURN
    done
    ip6tables -w 5 -A "$chain6" -d fc00::/7 -j REJECT
    ip6tables -w 5 -A "$chain6" -d fe80::/10 -j REJECT
    ip6tables -w 5 -A "$chain6" -j RETURN
  fi
}

configure_agentexec_network_guard

exec setpriv \
  --bounding-set=-net_admin \
  --inh-caps=-net_admin \
  --ambient-caps=-net_admin \
  --no-new-privs \
  -- /usr/local/bin/agentic-harness-worker "$@"
