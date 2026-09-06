# ADR 0017 — Separate host and Runtime-child OpenCode effective config authorities

## Status

Accepted.

## Context

Standalone execution has two operating-system authorities for OpenCode configuration:

- the persistent host OpenCode process runs on the developer/qualification host and needs host-native absolute paths;
- Runtime task OpenCode processes run inside the Linux worker container and need `/workspace/harness` and `/workspace/repository` paths.

The host launcher correctly materializes `<AGENT_HARNESS_PROJECT_ROOT>/.runtime/opencode.effective.json`. The Runtime worker historically generated its Linux effective config at that same project-owned path. Because the consuming repository is bind-mounted into `/workspace/repository`, a later host-side regeneration of the effective config overwrote the worker's Linux configuration with Windows/macOS/Linux-host paths while the worker process still pointed `OPENCODE_CONFIG` at the shared file.

A live qualification proved the collision: Runtime preparation, queueing, leasing and physical executor spawn all succeeded, then the Linux OpenCode child rejected a `{file:C:/Users/.../.harness/...}` reference from `/workspace/repository/.runtime/opencode.effective.json`.

## Decision

Host and Runtime-child effective configs are distinct artifacts with distinct authorities.

1. Host OpenCode continues to materialize `<consumer>/.runtime/opencode.effective.json`. It is project-owned runtime evidence and may contain host-native absolute paths normalized for OpenCode.
2. `generate-opencode-config.mjs` accepts `AGENT_HARNESS_OPENCODE_CONFIG_OUTPUT` as an explicit output authority.
3. The Runtime worker sets that output to `/tmp/agentic-harness/opencode.effective.json` before generating its configuration.
4. Runtime-child `OPENCODE_CONFIG` therefore points at a container-private file that cannot be overwritten by host regeneration through the `/workspace/repository` bind mount.
5. The child config still derives harness-owned prompts, instructions, skills and agents from `/workspace/harness` and project context from `/workspace/repository`.
6. `OPENCODE_CONFIG_CONTENT` remains a per-task overlay; it does not replace the need for a valid container-native base config.

## Consequences

- Host qualification/OpenCode evidence remains under the consuming project's `.runtime` directory.
- Runtime-child config is ephemeral container state, not promotion evidence and not source.
- Host and child paths can no longer clobber each other even when the host regenerates its effective config after the worker has started.
- Worker restart deterministically regenerates the child config from source/environment.
