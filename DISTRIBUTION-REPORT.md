# Agentic Harness v1 — standalone source distribution report

## Status

This archive is a **standalone source candidate** for the official Agentic Harness repository. It is derived from the Runtime V2 R17.4.5 source that reached `R17.4.5 PROMOTION PASS`, but the genericized standalone tree is a new distribution boundary and does not reuse the R17.4.5 promotion verdict as if no source changed.

Promoted lineage fingerprint:

`sha256:2030a87202a3dc5b877c7860f5374edeb97ca52f83ea9d324dc82b13ce2b5abf`

The immutable qualification evidence retained in this repository lives under `qualification/baseline/r17.4.5/`.

## Standalone boundary

The harness owns:

- reusable specialist-agent definitions and capability discovery;
- SDD workflow, generic PRD/design/test/implementation templates and schemas;
- dynamic DAG planning/compilation and Runtime V2 orchestration;
- PostgreSQL durable Runtime/ProjectMemory/continuation authority;
- RabbitMQ at-least-once transport and Rust physical worker;
- Context Engine, Redis exact/semantic cache integration and optional TEI embeddings;
- OpenCode configuration, project plugins, durable-continuation provenance and live progress;
- Headroom, Serena, Context7, codebase-memory and optional Caveman wiring;
- RTK project configuration and skill guidance;
- pinned Superpowers metadata/vendor boundary;
- bootstrap/doctor/up/down/migrate/test/qualify/OpenCode entrypoints.

The consuming project owns its product code and project-specific PRDs, ADRs, designs, test plans, runbooks, Task Briefs, Context Packets and policies.

## Architecture changes made for standalone use

1. `AGENT_HARNESS_ROOT` and `AGENT_HARNESS_PROJECT_ROOT` are distinct authorities. Harness source comes from the submodule; project source/workspaces/evidence remain in the consumer repository.
2. The former monolithic `.agents/registry.json` is removed. Capabilities are discovered from `.agents/agents/<agent>/agent.json`; dependency order is compiled at runtime from Technical Refinement `implementationPlan`.
3. Product-specific specialists and Clip Compass application/runtime surfaces are excluded from the operational harness.
4. Historical R12–R17 qualification scripts are not public package scripts. The public operational surface is intentionally bounded to ten stable `harness:*` commands.
5. Generic SDD authority for the harness itself is in `docs/specs/standalone-harness/`; historical qualification material is provenance only.

## Distribution inventory

- Generic specialist agents: 20
- Harness-owned skill directories: 22
- Artifact schemas: 11
- PostgreSQL harness migrations: 11
- Public `package.json` scripts: 10
- Standalone contract tests: 14
- Superpowers expected by lock: 14
- Superpowers skill trees physically recovered/vendorized in this archive: 10

## Superpowers vendor caveat

Ten real Superpowers skill trees were recovered from the user's prior source checkpoint and are included under `vendor/superpowers/skills`. The following four v5.1.0 directories were not present in any source archive available while building this package:

- `dispatching-parallel-agents`
- `requesting-code-review`
- `using-git-worktrees`
- `using-superpowers`

They were **not fabricated**. `vendor/superpowers/lock.json` pins the full v5.1.0 set and `scripts/vendor-superpowers.mjs` clones the exact tag, replaces the vendor tree, verifies all 14 skills and copies upstream license/readme. On a networked host, run that command once in the official harness repository and commit the resulting vendor tree; consumers are then fully offline for Superpowers skills.

## OpenCode configuration portability hardening

The reusable OpenCode template lives at `config/opencode.template.jsonc`, intentionally outside every filename/location that OpenCode auto-discovers as a project config. This is required on Windows: OpenCode performs `{env:...}` substitution while loading project configs, so a value such as `D:\\agentic-harness` can become an invalid JSON escape before parsing. The harness generator expands paths itself, normalizes Windows separators to `/`, serializes the effective config with `JSON.stringify`, and writes only `.runtime/opencode.effective.json`.

`opencode.json` and `opencode.jsonc` at the harness root are forbidden legacy artifacts. The launcher fails closed if either is present. Context7 is disabled in the generated config when `CONTEXT7_API_KEY` is absent; Context Engine defaults to `http://127.0.0.1:8789/mcp` when no explicit URL is configured. Host executable launchers use `shell: false` so Windows paths containing spaces are not truncated by `cmd.exe`.

## MCP launch portability hardening

The generated OpenCode config no longer relies on a bare `codebase-memory-mcp` command when the executable can be resolved. `scripts/internal/tool-resolution.mjs` resolves `CODEBASE_MEMORY_MCP_COMMAND`, the standard per-user cache location and finally the host PATH without using a shell; the effective config receives the absolute normalized executable path. This mirrors the reliable Windows installation shape while remaining user-agnostic.

Headroom uses two distinct pinned surfaces: `headroom-ai[proxy]==0.36.5` for the wrapper proxy and the canonical `headroom-ai[mcp]==0.36.5` package for `headroom mcp serve`. The generated MCP command receives the same explicit `--proxy-url http://127.0.0.1:${HEADROOM_PROXY_PORT:-8793}` owned by the wrapper, so MCP retrieval/stats cannot silently point at Headroom's unrelated default proxy port.

A plain `opencode mcp list` outside `harness:opencode` may exercise the user's global OpenCode config instead of `.runtime/opencode.effective.json`; standalone qualification must therefore prove MCP connectivity from the harness-launched OpenCode process/config, not infer it from the global list.

## Validation performed in the build environment

The distribution is checked with `node scripts/harness-test.mjs`, syntax/JSON/TypeScript-transpile checks, OpenCode effective-config generation and YAML parsing of `compose.yaml`.

The build sandbox did not provide Docker, Cargo, OpenCode, RTK or the codebase-memory executable, so live Compose build, Rust compilation, OpenCode plugin execution and external-tool probes cannot be claimed from this environment. `harness:doctor` reports these as host prerequisites rather than source-contract failures.

A target development host should run:

```bash
node .harness/bin/harness.mjs bootstrap
node .harness/bin/harness.mjs doctor
node .harness/bin/harness.mjs test
node .harness/bin/harness.mjs qualify
```

before the first stable repository tag is promoted.

## Package-lock policy

No fabricated `package-lock.json` is included. Direct npm dependencies are exact-pinned in `package.json`; generate and commit the lockfile in the official repository on a host that can resolve the dependency graph, then qualify that exact tree.

## Concrete source-candidate results

| Check | Result |
|---|---|
| Standalone contracts | PASS — 14/14 |
| Node syntax | PASS — 115 files |
| JSON parse | PASS — 70 files |
| TypeScript transpile/syntax | PASS — 107 files, 0 parse errors |
| `tsc --noEmit` | BLOCKED_ENVIRONMENT — `node_modules` / `@types/node` unavailable |
| Compose YAML parse | PASS — 7 services |
| OpenCode effective config generation | PASS — 20 agents / 2 local skill paths |
| Project-specific operational-source scan | PASS — 0 matches |
| User-specific absolute-path scan | PASS — 0 matches |
| Credential-token scan | PASS — 0 matches |
| `harness:qualify` | contracts PASS, then BLOCKED_ENVIRONMENT because Cargo is unavailable |

Machine-readable evidence: `validation/source-candidate-20260902.json`.
