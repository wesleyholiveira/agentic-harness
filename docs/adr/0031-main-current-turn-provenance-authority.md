# ADR 0031 — Main current-turn provenance authority

## Status
Accepted for the next standalone qualification candidate.

## Context
`agent_start` is fail-closed unless the persistent Main Orchestrator can prove the user message that authorized the current tool call. The previous plugin implementation re-read `/session/:id/message` from the persistent OpenCode HTTP server inside `tool.execute.before`, with an SDK fallback. On OpenCode 1.18.29 a real active Main turn produced an intermittent HTTP 400 while the same session was materializing its tool call; the post-turn history was healthy and contained the user message. The SDK client shape also differs across OpenCode generations.

## Decision
1. `chat.message` is the primary authority for the current human turn. It records the session-scoped user message identity before model/tool execution.
2. `tool.execute.before(agent_start)` consumes that current-turn identity first. It does not require a concurrent history round-trip to authorize the initial Runtime ingress.
3. Direct HTTP history and SDK history remain bounded recovery paths for plugin reload, durable continuation, and cases where the current-turn hook is unavailable.
4. SDK recovery supports both the current flat `session.messages({ sessionID, directory, limit })` shape and the generated-client `{ path, query }` shape.
5. A parked baseline is never released by reusing its cached current-turn message. When the cached message is still the parked baseline, the plugin refreshes history to prove a distinct durable-continuation or human turn.
6. HTTP history failures expose only bounded structural error identifiers; prompt/message bodies are never copied into provenance errors.
7. If no current-turn hook or recovery source proves a user message, `agent_start` remains fail-closed.
8. The Context Engine propagates `historySource`/bounded history error metadata into the request context, and Runtime persists accepted `agent_start` provenance as an authoritative `orchestrator.agent_start_provenance_accepted` PostgreSQL event in the same run-creation transaction. Standalone R-7 must prove that durable event has the same session/user identity, `provenanceSource=opencode-plugin-sidechannel`, `historySource=chat-message-hook`, and no history error before accepting the run. Optional logs remain diagnostic only.

## Consequences
The provenance guard no longer depends on a racy active-session history read for normal ingress, while recovery remains compatible with older and newer OpenCode clients. The logical Main Orchestrator contract is unchanged and no implementation authority is added to the Main.
