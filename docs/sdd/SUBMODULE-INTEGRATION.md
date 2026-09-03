# Consume Agentic Harness as a Git submodule

Recommended path: `.harness` at the root of the consuming repository.

```bash
git submodule add <official-agentic-harness-repository> .harness
git submodule update --init --recursive
node .harness/bin/harness.mjs bootstrap
node .harness/bin/harness.mjs doctor
```

The bootstrap writes only `.agent-harness/config.json` in the consuming repository. It does **not** copy the harness, create symlinks, or duplicate `.opencode`.

## Runtime

From the consuming project root:

```bash
node .harness/bin/harness.mjs up
```

`harness up` starts PostgreSQL, RabbitMQ, Redis, optional TEI, applies harness-owned database migrations, starts the Context Engine and then the Rust worker. The consuming repository is bind-mounted at `/workspace/repository`; the harness code is baked into the service images at `/workspace/harness`.

If OpenCode OAuth credentials exist at `~/.local/share/opencode/auth.json`, the launcher automatically passes that host file to the worker container. Override with `AGENT_HARNESS_OPENCODE_AUTH_HOST_FILE` when needed.

## OpenCode

```bash
node .harness/bin/harness.mjs opencode
```

The launcher keeps the OpenCode `cwd` at the consuming project while generating the effective configuration from the submodule. The generated file is project runtime evidence and is written to `<consumer>/.runtime/opencode.effective.json`; the harness submodule is never used as a runtime-output directory. The source template is `config/opencode.template.jsonc`; do not place `opencode.json` or `opencode.jsonc` at the harness root, because those names are auto-discovered by OpenCode and can make Windows `{env:...}` path substitution invalid before the generated config is applied. By default it starts the pinned Headroom proxy/wrapper and exposes the OpenCode server on `0.0.0.0:4096`. Disable only when desired:

```bash
AGENT_HARNESS_HEADROOM_ENABLED=false node .harness/bin/harness.mjs opencode
```

When the OpenCode server is password protected, set `OPENCODE_SERVER_PASSWORD` before both `harness:up` and `harness:opencode`; the harness projects it into the durable-continuation credentials without storing the secret in source.

## Superpowers

The official harness repository commits the complete pinned 14/14 `vendor/superpowers/skills` tree. To intentionally refresh or independently re-verify it against the pinned upstream tag, run on a networked machine:

```bash
node .harness/scripts/vendor-superpowers.mjs
```

Then commit the resulting `vendor/superpowers` changes in the harness repository itself, not in the consuming project.

## Project-specific authority

Keep product-specific artifacts in the consuming project:

- `docs/specs/**` and PRDs;
- domain ADRs/designs/test plans/runbooks;
- concrete Task Briefs and Context Packets generated for project work;
- code, tests and project-local policies.

The harness contains schemas/templates and generic architecture rules only. Agent manifests are capability catalogs. Task dependencies and parallelism come from the Technical Refinement `implementationPlan` and are compiled by the Runtime dynamic DAG.

## Updating the harness

```bash
git -C .harness fetch --tags
git -C .harness checkout <qualified-tag>
git add .harness
git commit -m "chore: update agentic harness"
```

Treat harness updates like infrastructure upgrades: run `node .harness/bin/harness.mjs qualify` before merging the submodule pointer update.

## RTK

RTK is intentionally treated as a host tool rather than copied into every consuming repository. The harness commits `.rtk/filters.toml` and the `use-rtk` skill; agents invoke the `rtk` executable directly when it is available on `PATH`. RTK does not require a global OpenCode plugin for the harness to remain portable. `harness:doctor` reports whether the binary is available.
