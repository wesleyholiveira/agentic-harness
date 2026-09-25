# ADR 0004 — Portable OpenCode integrations

**Status:** Accepted

## Decision

Keep one project-agnostic non-auto-discovered template at `config/opencode.template.jsonc` in the harness and generate runtime-effective configuration with absolute harness/project roots. The consuming project's cwd remains the OpenCode cwd, and the effective file is written only to `<AGENT_HARNESS_PROJECT_ROOT>/.runtime/opencode.effective.json`. Harness `.opencode` remains executable/plugin authority; consumer `.runtime` remains generated-evidence authority.

Pinned integrations:

- OpenCode host/server with repository-bound provenance plugin;
- Headroom `0.36.5` managed proxy/MCP plus the absolute self-contained OpenCode transport entry bundled in `headroom-ai[proxy]==0.36.5`;
- Serena `1.7.0` via `uvx`;
- Context7 via environment-provided token;
- codebase-memory-mcp via PATH/configured command;
- optional Caveman;
- RTK as an optional command-output reduction helper;
- Superpowers pinned to `v5.1.0`, with local vendored skills preferred.

Secrets are environment/runtime state and must never be committed. Durable continuation reuses OpenCode server authentication without embedding credentials in URLs.


> Runtime-child exception: ADR 0017 separates the Linux worker effective config into container-private ephemeral state. The project `.runtime/opencode.effective.json` authority described here applies to the persistent host OpenCode configuration/evidence.


## Host launch authority

ADR 0041 supersedes the historical host wrapper launch path. The persistent host now resolves the self-contained `headroom/providers/opencode/_dist/entry.opencode.js` from the exact pinned Headroom uvx environment, starts the proxy under harness supervision, and launches OpenCode directly with that absolute plugin entry. Runtime children remain isolated from this host-only integration.
