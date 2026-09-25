# ADR 0041 — Direct Headroom transport for persistent host OpenCode

**Status:** Accepted

## Context

The persistent host OpenCode launcher historically delegated the final process launch to
`headroom wrap opencode`. The Agentic Harness already owned the Headroom proxy lifecycle,
OpenCode effective configuration, MCP registration, project root, provenance plugin and
OpenCode port, so the wrapper introduced a second launch/configuration authority.

On Windows the wrapped launch was observed to terminate with native exit code
`3221226505` (`0xC0000409`) while the same qualified harness opened OpenCode normally
when `AGENT_HARNESS_HEADROOM_ENABLED=false`. The failure therefore sits on the wrapped
host launch path rather than the direct OpenCode path.

Headroom 0.36.5 already provides the `headroom-opencode` native plugin. The plugin accepts
`HEADROOM_PROXY_URL`, installs transport interception in-process and exposes Headroom
retrieve tooling without requiring Headroom to own the OpenCode process lifecycle.

## Decision

1. The Agentic Harness is the sole process-lifecycle authority for persistent host OpenCode.
2. Headroom remains pinned to `0.36.5` for this change. The native OpenCode plugin is pinned
   independently but to the same version as `headroom-opencode@0.36.5`.
3. The harness starts and health-checks the Headroom proxy itself, then launches
   `opencode` directly with `HEADROOM_PROXY_URL` and `HEADROOM_ACTIVE=1`.
4. `headroom wrap opencode` is removed from the operational host path.
5. The host effective OpenCode config enables the pinned native plugin and the Headroom MCP
   only when `AGENT_HARNESS_HEADROOM_ENABLED` is not `false`.
6. Runtime-dispatched OpenCode children do not load the native Headroom plugin and keep the
   existing child rule that disables host-only MCP integrations.
7. `AGENT_HARNESS_HEADROOM_ENABLED=false` remains the explicit operator bypass. It removes
   both the Headroom transport plugin and the Headroom MCP from the generated host config.
8. Headroom proxy startup is fail-closed. A proxy startup/readiness failure must not launch
   OpenCode without compression.
9. OpenCode exit status is propagated unchanged. When OpenCode exits or the host receives a
   termination signal, the harness terminates the managed Headroom proxy process tree.
10. Existing outer provider proxy chaining remains explicit: inherited provider base URLs
    are projected into Headroom `*_TARGET_API_URL` variables and removed from the child
    environment so there is a single provider-routing authority.
11. The change does not introduce a `headroom/*` default model or provider remap. Existing
    Agentic Harness model routing remains authoritative.

## Invariants

- **HHR-1** — Persistent host OpenCode is launched directly by the harness.
- **HHR-2** — Headroom proxy lifecycle is supervised by the harness.
- **HHR-3** — Host transport uses the pinned native plugin and explicit
  `HEADROOM_PROXY_URL`.
- **HHR-4** — No operational host path invokes `headroom wrap opencode`.
- **HHR-5** — Runtime children never inherit the host Headroom transport plugin.
- **HHR-6** — Explicit Headroom disablement removes both plugin and MCP integration.
- **HHR-7** — Proxy startup failure is fail-closed.
- **HHR-8** — OpenCode exit codes are not normalized or hidden.
- **HHR-9** — Managed proxy cleanup is deterministic after OpenCode termination.
- **HHR-10** — Existing model identifiers and routing policy remain unchanged.

## Verification

The contract suite must prove:

- the pinned host plugin version matches the pinned proxy version;
- the direct launch command is `opencode`, not `uvx ... headroom wrap opencode`;
- the direct child environment contains `HEADROOM_PROXY_URL` and `HEADROOM_ACTIVE=1`;
- outer provider proxy chaining is preserved without leaking competing base URLs;
- a proxy startup failure results in zero OpenCode launches;
- a native Windows-style exit code such as `3221226505` is returned unchanged;
- the proxy is cleaned up after OpenCode exits;
- qualification reads the telemetry-disabled local `/stats.requests.total` counter before and after the real R-7 workload and requires it to increase;
- host config includes the plugin/MCP only when enabled;
- runtime-child config excludes the plugin and disables the Headroom MCP.

A target-host live smoke must additionally open `npm run harness:opencode` on Windows with
Headroom enabled and confirm that the TUI remains alive. Full promotion still requires the
normal standalone qualification gates for the resulting source identity.

## Consequences

The persistent host no longer has two competing process supervisors. Headroom continues to
provide token-saving transport and MCP capabilities, while the harness keeps authority over
OpenCode configuration, lifecycle, provenance and routing. A later Headroom version upgrade
is intentionally a separate source change and must be qualified independently.
