# ADR 0008 — Runtime invocation provenance follows the effective Context Engine authority

## Status

Accepted.

## Context

The standalone qualification can allocate a dedicated host port for Context Engine. OpenCode MCP traffic already follows `AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL`, but the provenance plugin previously posted to a separate implicit `127.0.0.1:8789` endpoint. With another Context Engine already bound there, the first live `agent_start` could register against the wrong runtime and receive HTTP 409 because the expected plugin source SHA belonged to a different harness revision.

The Context Engine also validates the exact plugin source SHA, so the image performing that validation must contain the same plugin source that the host OpenCode process loads.

## Decision

1. The OpenCode launcher derives `AGENT_HARNESS_RUNTIME_INVOCATION_PROVENANCE_URL` from the effective `context-engine` MCP URL unless an explicit provenance URL is supplied.
2. The provenance plugin uses the explicit provenance URL first, otherwise derives `/runtime-invocation-provenance` from `AGENT_HARNESS_CONTEXT_ENGINE_MCP_URL`, and only falls back to `127.0.0.1:8789` when neither authority is configured.
3. `CONTEXT_ENGINE_HTTP_PORT` is not a host-side provenance routing authority. It is an internal Context Engine listener concern.
4. The Context Engine image copies `.opencode/plugins/runtime-invocation-provenance.js` and validates registrations against the SHA of that exact packaged file.
5. A qualification using a dedicated Context Engine port must prove the first live provenance registration reaches that same endpoint; a 409 from another Context Engine is a routing failure, not an acceptable retry target.

## Consequences

OpenCode MCP calls and provenance registration share one runtime authority. Dedicated qualification ports no longer cause the plugin to contact a preexisting service on 8789, and plugin-SHA validation remains fail-closed against the source actually packaged in the current Context Engine image.
