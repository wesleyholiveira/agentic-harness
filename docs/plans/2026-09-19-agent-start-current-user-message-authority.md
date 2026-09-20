# Execution Plan — robust agent_start request ingress

Date: 2026-09-19
Status: implemented candidate

## Goal

Eliminate model-side JSON truncation for long delivery prompts while preserving fail-closed Runtime V2 provenance and backward compatibility.

## Flow

```text
explicit human message
  -> OpenCode chat.message cache/history
  -> Main Orchestrator: runtime-continuation
  -> agent_start({requestSource:"current-user-message", continuation})
  -> provenance plugin hashes + bounds original message
  -> /runtime-invocation-provenance sidechannel
  -> Context Engine validates message id/bytes/SHA-256
  -> matching MCP call consumes short-lived provenance record
  -> authoritativeAgentStartArgs materializes request server-side
  -> AgentRuntimeControlPlane.start({request,...})
  -> SDD / dynamic DAG
```

## Invariants

- No full user-message text in structured Context Engine logs.
- Sidechannel and MCP call remain correlated by exact tool name + arguments digest.
- Only explicit-human-turn provenance can materialize current-user-message.
- Inline request + requestSource is invalid.
- Legacy explicit request remains valid.
- Continuation session id is still canonicalized from trusted provenance.
- No changes to PostgreSQL/RabbitMQ durability authority.

## Validation

```bash
node --test tests/contracts/agent-start-session-authority.test.mjs
node --test tests/contracts/agent-start-current-user-message-authority.test.mjs
npm run harness:test
node scripts/internal/source-manifest.mjs --check
npm run harness:qualify
```

Promotion remains contingent on a fresh standalone qualification PASS for the exact resulting source SHA.
