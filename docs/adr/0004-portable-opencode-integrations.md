# ADR 0004 — Portable OpenCode integrations

**Status:** Accepted

## Decision

Keep one project-agnostic non-auto-discovered template at `config/opencode.template.jsonc` in the harness and generate runtime-effective configuration with absolute harness/project roots. The consuming project's cwd remains the OpenCode cwd.

Pinned integrations:

- OpenCode host/server with repository-bound provenance plugin;
- Headroom `0.36.5` wrapper/MCP;
- Serena `1.7.0` via `uvx`;
- Context7 via environment-provided token;
- codebase-memory-mcp via PATH/configured command;
- optional Caveman;
- RTK as an optional command-output reduction helper;
- Superpowers pinned to `v5.1.0`, with local vendored skills preferred.

Secrets are environment/runtime state and must never be committed. Durable continuation reuses OpenCode server authentication without embedding credentials in URLs.
