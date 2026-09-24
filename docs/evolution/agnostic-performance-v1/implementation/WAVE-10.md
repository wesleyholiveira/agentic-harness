# Implementation wave 10 — Rust worker gateway integration under fence

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Parent: `5184ac3c604530ad024fd09b7d66818b480f2080`.

## Goal

Activate committed CommandSpec behavior validation in the event-driven Rust
worker without exposing Docker socket authority, Runtime control-plane
credentials or a reusable gateway bearer credential to model-controlled
processes.

## Delivered

### Behavior-gate descriptor

`event-driven-preparation.mjs` emits `behaviorGate` only when an implementation
Task Brief carries non-empty committed `commandSpecIds`.

The descriptor contains only:
- commandAuthority/v1;
- commandSpecIds;
- isolated workspacePath.

It does not contain capability material, PostgreSQL credentials or Docker access.

Typed behavior execution requires workspace mode `copy`; `none` fails closed.

### Model-wide restricted executor boundary

Every model-controlled `executionMode=agent` now executes through the
restricted model boundary, whether or not the task has a behavior gate.

The Rust worker:
- requires an isolated `copy` workspace for model-controlled execution;
- creates UID/GID 10001 (`agentexec`) at image build time;
- chowns the isolated task workspace and a task-scoped temporary HOME;
- places model-owned handoff/repair artifacts under a dedicated
  `agent-output-attempt-N/` subdirectory;
- validates that log/result/change-set remain in the root-owned parent task
  directory and grants UID 10001 write authority only to the per-attempt model
  output subdirectory;
- copies OpenCode auth into the temporary HOME;
- removes PostgreSQL, RabbitMQ, Redis/cache, behavior-gateway/HMAC and OpenCode
  continuation credentials from the child environment;
- spawns the child as UID/GID 10001;
- starts every model-controlled child in a dedicated Unix process group.

The worker image installs a UID-scoped egress guard. At startup it:
- allows UID 10001 to reach the exact `context-engine` service address on TCP
  8789;
- rejects private/link-local IPv4 and private/link-local IPv6 destinations for
  UID 10001;
- leaves public provider/model endpoints reachable;
- installs the rules while the container has `NET_ADMIN`;
- drops `NET_ADMIN` from the long-lived worker bounding/inheritable/ambient
  capability sets before the Rust worker starts;
- enables `no-new-privs` for the worker and descendants.

After a model executor exits, the worker drains bounded output and terminates
the isolated process group. For behavior-gated tasks, the temporary HOME is
removed and only then is gateway capability material minted.

This prevents a model child or surviving descendant from reading the root
worker environment or reaching PostgreSQL/RabbitMQ/Redis/the Docker gateway
through the worker network.

### Constructible post-commit source-attested images

Target validation exposed a pre-runtime authority defect in the WAVE-08 local
image model. A one-off descriptor that embeds its future image digest cannot
also be part of the source snapshot stamped into that same image without
creating a self-reference.

ADR 0042 adds `image.mode=source-attested-build` for locally built one-off
runners. In this mode:
- the committed descriptor carries no future image digest;
- `buildTarget` is mandatory;
- the image is built only after the consumer commit exists;
- the trusted builder stamps the existing sourceSnapshot/runnerSpec/sourceBinding
  authority labels from that commit;
- materialization resolves exactly one image matching all three labels;
- missing or ambiguous matches HOLD;
- subsequent toolchain and behavior execution use only the immutable materialized
  image ID.

The standalone qualification fixture now commits a real ProjectDescriptor/v2
and execution policy, builds a Node behavior runner after the exact harness
gitlink commit, proves materialization + source attestation in R-3, and starts
the isolated behavior gateway in R-4 on the same Runtime workspace volume.

### Gateway Docker CLI compatibility

The first deterministic live preflight on candidate
`3e091f1083509758971aaa1c14e5f73a9b972713` reached the real Docker behavior
executor and failed only at container creation with Docker exit code 125.

Evidence proved that command authority, committed config, workspace binding,
source-attested image materialization, image attestation, toolchain readiness,
HMAC capability verification and execution-fence admission had all succeeded
before the failure.

Root cause: `apps/docker-gateway/Dockerfile` inherited Debian Bookworm's
`docker.io` package (20.10.24), while the behavior executor requires
`--mount ... volume-subpath=...`. Docker added `volume-subpath` support in
CLI/Engine 26.0 / API 1.45.

Correction:
- gateway now copies the official Docker CLI 27.5.1 from
  `docker:27.5.1-cli`;
- the Debian `docker.io` package is no longer installed in the gateway;
- the live preflight probes the gateway's actual Docker client version and
  daemon API before behavior execution;
- client major <26 or server API <1.45 fails with
  `wave10_preflight_docker_subpath_runtime_unsupported`;
- contracts pin this compatibility boundary so a base-image/package regression
  cannot silently reintroduce exit 125.

### Deterministic live preflight before LLM qualification

A dedicated host-side preflight now exercises the complete behavior data plane
without invoking OpenCode or any model:

`scripts/qualification/wave10-live-preflight.mjs`.

It:
- requires a clean exact harness HEAD;
- creates a disposable Git consumer and pins that exact harness as a gitlink;
- builds the `source-attested-build` runner after the consumer commit;
- proves image materialization and source attestation;
- starts only PostgreSQL, migrations and the isolated Docker behavior gateway;
- copies the committed consumer workspace into the real shared Runtime volume;
- inserts a real running task fence plus HMAC capability checkpoint into
  PostgreSQL;
- sends the raw capability to the gateway through process stdin so ProcessRunner
  evidence never serializes it in argv or command logs;
- executes `qualification.behavior.tests` through the real gateway;
- requires one `BEHAVIOR_PASSED` receipt bound to the expected source snapshot;
- verifies the exact fence-derived Docker container name no longer exists;
- performs compose-volume/image/temp-workspace cleanup and converts cleanup
  failure to HOLD.

The behavior CommandSpec is intentionally scoped to
`node --test test/format-name.test.mjs`; it cannot accidentally traverse the
pinned `.harness` submodule and relabel harness-contract execution as consumer
behavior evidence.

### Fence-bound ephemeral capability

The worker generates two UUIDv4 values concatenated into a 64-hex capability
only after model execution.

The persisted checkpoint never contains the raw capability. Its proof is:

HMAC-SHA256(
  secret,
  runId || taskId || attempt || dispatchGeneration || fencingToken ||
  leaseOwner || capability
)

The HMAC key:
- is optional for legacy/non-behavior execution;
- must be at least 32 bytes for typed behavior execution;
- has no default;
- is present only in the trusted worker/gateway service environment;
- is explicitly removed from model child environments;
- is not serialized into descriptor, checkpoint payload, result or logs.

### Gateway PostgreSQL verification

The gateway lazily creates one bounded PostgreSQL pool per process.

Before loading committed configuration or using Docker, it verifies:
- run is running;
- task is running;
- attempt matches;
- dispatch generation matches;
- fencing token matches;
- lease owner matches;
- lease has not expired;
- checkpoint HMAC proof matches the supplied raw capability.

Connection/query/statement timeouts are bounded so PostgreSQL degradation
fails closed instead of leaving behavior execution unsupervised.

A capability mismatch, stale fence, expired lease or capability-store outage
returns HOLD before Docker.

The prior long-lived bearer-token constructor remains removed.

### In-flight Docker revocation

Behavior Docker execution is asynchronous and receives a deterministic,
fence-bound container name.

While a behavior command is running, the gateway:
- re-verifies capability/fence authority against PostgreSQL on a bounded poll;
- verifies authority again after the Docker command exits and before accepting
  the receipt;
- aborts the Docker CLI and force-removes the named container when the fence is
  replaced, expires or becomes unverifiable;
- aborts and removes the named container when the worker HTTP client disconnects;
- performs repeated post-abort `docker rm -f` cleanup to cover daemon/create
  races.

Therefore losing authority is no longer only an observation in the Rust
worker: it actively revokes the already-started behavior container.

### Rust gateway client with lease supervision

Module:
`apps/runtime-worker/src/behavior_gateway.rs`.

While waiting for the gateway:
- lease heartbeat continues every 15 seconds;
- heartbeat update is owner/generation/fence scoped;
- the worker checks cancellation/fence every second;
- gateway HTTP timeout is bounded by configuration;
- after response, the worker verifies the same active fence again.

Transport/fence failures become a redacted HOLD receipt.

### Result/finalizer integration

`AgentExecutionResult` optionally carries `behaviorGate`.

The event-driven finalizer:
- records `behavior.gateway.result`;
- writes non-reusable `behavior.gateway.receipt` checkpoint evidence;
- maps FAILED to `behavior_validation_failed` (retryable code failure);
- maps HOLD to `behavior_gateway_hold` (fail-closed contract/authority failure).

The original model executor exit code is preserved separately.

### Docker authority remains isolated

Only `docker-behavior-gateway` receives `/var/run/docker.sock`.
The Rust worker still has no Docker socket.

The gateway profile uses:
- read-only root;
- read-only project/workspace mounts;
- dropped capabilities;
- no-new-privileges;
- no published host port.

## Tests and exact-SHA qualification

The focused Node suite includes `runtime-regressions.test.mjs` and now covers:
- capability rejection before config/Docker;
- HMAC/fence mismatch and expiration behavior;
- in-flight fence replacement abort;
- worker/client disconnect abort;
- deterministic fence-bound container naming;
- repeated revoked-container cleanup;
- bounded PostgreSQL verification;
- model-wide UID/process-group/temporary-HOME isolation;
- model child control-plane credential removal;
- UID-scoped private-network rejection with exact Context Engine exception;
- attempt-scoped model-output write authority without write access to Task Brief,
  context, descriptor, log or result authority files;
- behavior result/finalizer projection.

The actual TAP count is authoritative; do not gate on the older approximate
WAVE-09/WAVE-10 test-count estimate.

Rust:
`cargo test --locked --manifest-path apps/runtime-worker/Cargo.toml`

must pass. `cargo fmt --manifest-path apps/runtime-worker/Cargo.toml -- --check`
must also pass after the Rust hardening changes.

Because source identity hashes all committed tracked files, qualification is
always exact-SHA. Candidate `e6dd924745c396ec03a05372b87c0d89bd23888e`
was operator-confirmed GREEN for focused Node contracts, Rust fmt +
`cargo test --locked`, Compose config, Docker contract target (264/264), and
the worker/gateway image builds. That evidence closes the preceding static
REDs, but it became historical-only when ADR 0042 and the source-attested
runtime fixture changed tracked source. The next candidate must rerun the cheap
source/build gates before live WAVE-10 faults are armed.

## Live preflight result

Candidate `0d8c0b6ec4c034429d496822a6a2cc780f9a31bb` passed the deterministic
no-LLM live preflight on the target Windows/Docker Desktop host.

Observed evidence:
- exact clean harness HEAD and exact consumer gitlink;
- source-attested behavior image materialized and attested;
- Docker client 27.5.1 and daemon API 1.55;
- real PostgreSQL fence/capability verification;
- real gateway execution returned `PASSED / docker_gateway_behavior_passed`;
- behavior receipt returned `BEHAVIOR_PASSED / behavior_passed`;
- exact fence-bound behavior container was absent after execution;
- raw capability and HMAC key were not persisted in preflight evidence;
- cleanup completed with zero errors.

This proves only the happy path. In-flight revocation/outage and physical worker
loss remain separate blocking gates.

## Deterministic fault preflight

The next host-side gate is implemented in
`scripts/qualification/wave10-fault-preflight.mjs`.

It reuses the exact source-attested qualification fixture but drives the
gateway from a separate constrained client container on the Compose network,
which is closer to the Rust worker topology than executing the HTTP client
inside the gateway container.

The preflight owns three independent scenarios:

1. **in-flight fence replacement**
   - starts `qualification.behavior.delay`;
   - waits for the exact fence-derived behavior container to be running;
   - advances the authoritative PostgreSQL fencing token;
   - requires `HOLD / docker_gateway_fence_identity_mismatch`;
   - requires zero accepted receipts and physical removal of the named
     behavior container.

2. **in-flight PostgreSQL outage**
   - starts the same delayed behavior;
   - stops PostgreSQL while the container is running;
   - requires `HOLD / docker_gateway_capability_store_unavailable`;
   - requires physical container removal;
   - restarts PostgreSQL and proves a new behavior request succeeds using the
     same gateway process, demonstrating pool recovery without gateway restart.

3. **gateway outage before behavior execution**
   - seeds valid task/fence/capability authority;
   - stops the gateway before the client request;
   - requires transport failure with zero behavior container materialization;
   - restarts the gateway and retries the same valid authority;
   - requires `PASSED / BEHAVIOR_PASSED` and normal container cleanup.

The concurrent client request transports raw capability only over stdin.
`ProcessRunner.start` now arms process completion before writing stdin,
captures bounded stdout/stderr for deterministic assertions, and never
serializes stdin into command logs.

This gate is deliberately separate from physical Rust worker loss. Worker loss
must still prove client-disconnect revocation plus semantic replacement
generation/fence recovery through the actual worker/dispatch plane.

## Fault-preflight findings

Candidate `fc3e5f7423b57a851ff3752526f472ce36ee4451` proved the first
fault scenario end-to-end:

- delayed behavior container became physically running;
- PostgreSQL fencing token advanced from 1 to 2 while it was in-flight;
- gateway returned `409 / HOLD / docker_gateway_fence_identity_mismatch`;
- receipts array was empty;
- the fence-derived behavior container was removed.

The same run then exposed a production bug in the PostgreSQL outage path.
When PostgreSQL was stopped while a delayed behavior container was running,
the client observed `UND_ERR_SOCKET` instead of the expected fail-closed
HTTP response. Root cause was an unhandled `pg.Pool` background `error`
event from an idle connection. Node treats an unhandled EventEmitter
`error` as fatal, so the gateway process exited before it could return
`docker_gateway_capability_store_unavailable`.

The verifier now registers a Pool error listener to keep the gateway process
alive. Query failures remain authoritative and continue to map to
`docker_gateway_capability_store_unavailable`. The fault preflight also
captures gateway container id, PID and RestartCount before the outage and
requires all three to remain unchanged after PostgreSQL recovery. Recovery is
bounded to five attempts, retrying only the same store-unavailable HOLD.

## Fault preflight PASS and physical worker-loss integration

Candidate `51c1b8ffdff0da1917b90dafaf6a288fd43172b5` passed the complete
deterministic no-LLM fault preflight
`wave10-fault-preflight-1790039570229-045992690cb5`.

Observed:
- in-flight fence replacement returned
  `docker_gateway_fence_identity_mismatch`, accepted zero receipts and removed
  the source container;
- in-flight PostgreSQL outage returned
  `docker_gateway_capability_store_unavailable`, removed the behavior
  container and recovered on the first probe without restarting the gateway;
- gateway container id, PID 96458 and RestartCount 0 were identical before and
  after PostgreSQL recovery;
- gateway outage failed closed at transport, materialized no behavior container,
  and recovered to `PASSED / BEHAVIOR_PASSED`;
- raw capability and HMAC key remained absent from evidence;
- cleanup completed with zero errors.

ADR 0043 extends the existing R-9 physical worker-loss qualification instead of
adding another model run. Under the internal
`repair-checkpoint-before-behavior` boundary, Context Engine injects
`qualification.behavior.delay` only for the matching qualification task and
attempt. Its command authority is derived from the trusted committed project
configuration and any pre-existing authority must match exactly.

The full-agent executor writes the existing durable process-loss checkpoint but
does not block. R-9 waits for both the authoritative
`behavior.gateway.started` event and the exact fence-derived behavior
container to be physically running before SIGKILLing worker PID 1.

Qualification then requires:
- source behavior container removal on worker HTTP disconnect;
- stable gateway container/PID/RestartCount;
- exact killed lease expiry;
- exactly one worker restart;
- same semantic task attempt with dispatch generation and fence each +1;
- unchanged repair checkpoint effect key;
- `skippedFullAgentInvocation=true`;
- replacement behavior container physically running;
- replacement `behavior.gateway.completed = PASSED` with one receipt;
- replacement behavior container removal;
- closed semantic run;
- Context Engine and worker qualification controls disarmed before R-10.

This implementation is pending exact-SHA cheap gates and live R-9 qualification.

## Scoped worker-loss qualification source boundary

The first attempt to run the upgraded standalone qualification on candidate
`3d7cfc5a9f89616fb620e2fa9e2e8916680576a9` stopped correctly at R-0
before any Runtime/model gate. PRE-R0 proved the exact clean HEAD, while
`source-manifest.mjs --check` reported the final-release MANIFEST was stale:
688 tracked source files excluding MANIFEST versus 547 entries in the existing
manifest.

This is not a WAVE-10 runtime failure. MANIFEST regeneration remains a T17
release-closure operation.

ADR 0044 adds the explicit non-promotional scope:

`node scripts/qualification/standalone-v1.mjs --wave10-worker-loss`

The scope:
- retains clean exact HEAD and live `git-tracked-worktree` source identity;
- runs the ordinary R-0 source/ingress invariants but records
  `MANIFEST=DEFERRED_T17`;
- is permanently `promotionEligible=false`;
- runs Q-ENTRY, PRE-R0, R-0 through R-6, then R-9 and R-11;
- excludes R-7, R-8 and R-10 because they do not establish state consumed by
  the physical worker-loss gate;
- emits report metadata that labels the result
  `wave10-worker-loss` and `NOT A RELEASE PROMOTION`.

The default standalone command remains unchanged: full promotion still requires
the exact committed MANIFEST and therefore continues to fail closed until T17.

## Historical-product reference classification correction

The first scoped worker-loss run on candidate
`2dd72760a4f9ee7ab267239c8ef584604df2814b` reached scoped R-0 with the
expected `MANIFEST=DEFERRED_T17` source authority, then stopped on
`r0_product_specific_operational_reference`.

All observed matches were under `docs/evolution/**`: WAVE-05 history and
WAVE-10 adoption/release-boundary notes that intentionally document the
project from which the standalone harness was extracted. Those files are
historical migration/evolution evidence, not Runtime or operational authority.

The R-0 product namespace scan now excludes only:
- `docs/evolution/**`;
- `qualification/baseline/r17.4.5/**`.

References remain blocking everywhere else, including:
- `docs/adr/**`;
- `.agents/**`;
- `apps/**`;
- `packages/**`;
- `scripts/**`;
- Compose/config/root source.

The rule remains fail-closed for any real product coupling while allowing the
repository to retain its own historical evolution record.

## Scoped R-1 regression closure

Scoped candidate `11b8d4004a7acd9eddc6be51f099452a9af713fe` passed
Q-ENTRY, PRE-R0 and scoped R-0, including
`MANIFEST=DEFERRED_T17`, then stopped at R-1 because the complete
`harness:test` suite reported 464 PASS / 7 FAIL.

The seven failures split into two classes.

### Contracts not reconciled with intentional WAVE-10 behavior

Four pre-existing contracts still encoded the prior runtime shape:
- qualification product-namespace self-scan excluded only the promoted baseline,
  not `docs/evolution/**`;
- project-agnostic structure scan treated historical evolution evidence as
  operational source;
- R-9 expected process-loss controls to be absent from Context Engine rather
  than blank-default qualification controls;
- legacy process-loss resolver expectation did not include the new explicit
  `blockUntilProcessLoss` field.

These contracts now consume the same centralized operational/historical
classification and assert blank-default controls on both Context Engine and
worker.

### Technical Plan canonicalization regressions

Three failures exposed a runtime-owned validation-authority gap:
- semantic review repair could accept a model plan that omitted
  `validationCommandIds` and then fail validation instead of re-projecting
  deterministic IDs;
- mechanical normalization preserved downstream-only acceptance criteria when
  the implementation projection was empty;
- invalid/unauthorized validation prose could survive canonicalization when the
  authorized projection was empty, forcing a whole-plan rewrite instead of the
  bounded criterion-assignment repair.

Corrections:
- implementation criteria are projected exactly once a valid implementation
  criterion is known; criterionless pre-repair items retain a schema-valid
  transient shape so bounded criterion assignment can run;
- validation/validationCommandIds are exact Runtime projections whenever a
  positive trusted command projection exists; invalid prose remains visible
  only during pre-repair so deterministic issue classification can route the
  bounded repair instead of manufacturing schema-invalid empty arrays;
- legacy executable commands survive only when present in the trusted catalog;
- full-plan synthesis output and semantic-review repair output are
  re-canonicalized before deterministic validation;
- semantic mutation evidence is computed only after Runtime-owned
  canonicalization so omitted IDs/authority cannot masquerade as model
  mutations.

R-1 remains a full-suite gate; no failing test is skipped by the scoped
qualification.

## Criterion-assignment transient schema correction

The focused rerun of the previously failing Technical Refinement test exposed a
follow-up ordering bug. Pre-repair canonicalization removed the downstream-only
criterion and invalid validation prose from a criterionless work item, producing
empty `acceptanceCriteria` and `validation` arrays. The final implementation
plan schema correctly requires at least one item in both fields, so the flow
failed at schema validation before the bounded criterion-assignment repair could
attach the missing implementation criterion.

Correction:
- pre-repair normalization preserves the schema-valid transient criterion/prose
  on criterionless work items;
- those values remain explicit deterministic issues and therefore cannot pass
  final validation;
- after criterion assignment, canonicalization removes downstream-only criteria,
  projects the exact trusted validation command and Runtime-owned IDs, and the
  final schema is validated normally;
- the workflow contract now pins both the transient and final shapes.

No schema relaxation was introduced.

## Scoped R-2 rustfmt closure

Scoped run `standalone-v1-1790045777308-d6d91d52b1da` on candidate
`54e3a3ed786af59d81ad8e5a3be79d641b14882d` proved:

- Q-ENTRY PASS;
- PRE-R0 PASS on the exact clean source;
- scoped R-0 PASS with `MANIFEST=DEFERRED_T17`;
- R-1 PASS with the complete `harness:test` contract/syntax/inventory gate.

R-2 then stopped before compilation because
`cargo fmt --manifest-path apps/runtime-worker/Cargo.toml -- --check`
reported formatting-only diffs in:
- `apps/runtime-worker/src/agent_runtime.rs`;
- `apps/runtime-worker/src/behavior_gateway.rs`;
- `apps/runtime-worker/src/config.rs`;
- `apps/runtime-worker/src/main.rs`.

The reported rustfmt projection was applied exactly. No runtime semantics,
authority, timeout, SQL, fence, HMAC, gateway or worker lifecycle behavior was
changed.

The next exact-source gate is therefore the focused rustfmt check, followed by
the scoped qualification if formatting is clean.

## Scoped R-2 Clippy closure

Scoped run `standalone-v1-1790046589561-9bb35f7b0c5c` on candidate
`227cacb064420bf598e85d63483412734a6609bf` preserved Q-ENTRY, PRE-R0,
R-0 and complete R-1 PASS, then advanced further inside R-2. The first
divergence became `cargo clippy --all-targets --all-features -- -D warnings`.

Clippy reported five warnings-as-errors:
- `BEHAVIOR_AGENT_UID` and `BEHAVIOR_AGENT_GID` were dead code on the
  Windows qualification host because their uses are Unix-only;
- three `as_bytes().len()` calls were unnecessary for byte-length checks on
  Rust strings.

Corrections:
- both restricted-agent UID/GID constants are now compiled only under
  `#[cfg(unix)]`, matching their actual chown/uid/gid execution surface;
- the three length checks use `.len()`, preserving Rust string byte-length
  semantics without lint suppression.

No `allow` or `expect` attribute was introduced and no behavior-gateway,
fencing, HMAC or restricted-user semantics changed.

## Scoped R-4 Compose profile correction

Scoped run `standalone-v1-1790046982294-cc303fd69be5` on candidate
`12702c35bc68f569d863b7c3a2dcb267b1a132ab` proved Q-ENTRY, PRE-R0,
R-0, R-1, R-2 and R-3 PASS.

R-4 then failed before behavior-gateway startup because the qualification
controller invoked Compose with only `--profile behavior-gateway`.
The `docker-behavior-gateway` service depends on `database-migrate`, while
`database-migrate` belongs to the `runtime` profile. Compose therefore
rejected the project as invalid with
`depends on undefined service "database-migrate"`.

The R-4 gateway startup now activates both profiles:

`--profile runtime --profile behavior-gateway up -d docker-behavior-gateway`

This matches the already-qualified live/fault preflight topology. Startup
remains target-scoped to the gateway; the runtime profile is enabled only so
its declared dependency graph is valid.

A contract now pins this exact profile combination.

## Scoped R-9 worker-image dependency-closure correction

Scoped run `standalone-v1-1790047821052-baa404c33079` on candidate
`e200f432b8aff5b94d676d32ae6fee71b06ca492` proved Q-ENTRY, PRE-R0,
R-0, R-1, R-2, R-3, R-4, R-5 and R-6 PASS.

R-9 armed the intended worker-loss controls, but the semantic run failed before
Technical Refinement. Product Discovery exited three times with
`ERR_MODULE_NOT_FOUND` because
`.agents/runtime/technical-plan-synthesis.mjs` imports
`packages/project-adapters/src/command-spec-catalog.mjs`, while the
`agent-runtime-worker` image did not copy `packages/**` at all.

The missing module was not isolated: `command-spec-catalog.mjs` depends on
`trusted-config.mjs`, which in turn depends on `packages/source-identity/**`
and `packages/harness-contracts/**`. Copying only the first missing file would
therefore have produced a sequence of later module-resolution failures.

Correction:
- the runtime worker image now copies the complete `packages/` tree;
- the image build executes
  `await import('./.agents/runtime/technical-plan-synthesis.mjs')`;
- this makes the Docker build itself prove the executor's complete local JS
  module closure before qualification can proceed;
- a Runtime regression contract pins both the package copy and the build-time
  import smoke.

No behavior fence, model routing, retry, gateway, command authority or process
loss semantics changed.

## Scoped R-9 restricted OpenCode state-root correction

Scoped run `standalone-v1-1790112380611-f4129aab0581` on candidate
`848344fe63ca5cb8aeae34159944c9f2cfe91b80` again proved Q-ENTRY,
PRE-R0 and R-0 through R-6 PASS.

The previous runtime-worker module-closure defect was resolved: Product Discovery
loaded its Agent Input Manifest and entered the OpenCode executor. It then failed
on all three task attempts before any model invocation because the restricted
UID 10001 tried to create:

`.runtime/.../tasks/<task>/opencode-attempt-state`

The task directory is intentionally root/control-plane-owned. The Rust worker
only grants the model child write ownership to:
- its copy workspace;
- its attempt-scoped HOME;
- the dedicated `agent-output-attempt-*` directory.

The executor had incorrectly derived OpenCode state from
`dirname(manifestPath)`, violating that ownership boundary.

Correction:
- Rust now removes any inherited
  `AGENT_HARNESS_AGENT_EXECUTION_STATE_ROOT`;
- for model-agent execution it projects
  `AGENT_HARNESS_AGENT_EXECUTION_STATE_ROOT=<restricted HOME>/runtime-state`;
- inherited `XDG_DATA_HOME` and `XDG_STATE_HOME` are removed before the
  restricted child is spawned;
- `prepareIsolatedOpenCodeAttemptEnv()` gives that Runtime-projected root
  precedence and creates per-attempt XDG data/state below it;
- the existing restricted HOME cleanup removes the entire state/auth copy
  before behavior execution;
- manifest-adjacent state remains only as a legacy/non-Runtime fallback.

No write permission was added to the root-owned task directory and no provider
credential is persisted into the durable agent-output evidence directory.

## Scoped R-9 OpenCode nonzero diagnostic closure

Scoped run `standalone-v1-1790114835041-d14c2db63d85` on candidate
`f8020cd110ed15657cae520f855a3cf5e16326cc` again proved Q-ENTRY,
PRE-R0 and R-0 through R-6 PASS.

The restricted-state-root correction is proven:
- `opencode.state_isolated` reported
  `authority=runtime-projected-ephemeral-home`;
- the provider auth file was copied into the ephemeral XDG data root;
- OpenCode spawned successfully;
- a real OpenCode session was observed.

The remaining failure moved to the first OpenCode prompt. The pinned worker
OpenCode v1.18.26 returned exit status 1 after roughly 11 seconds on each
Product Discovery attempt. The CLI produced 218 stdout bytes but no useful
provider/model error in the stderr tail persisted by Runtime.

Inspection of the pinned OpenCode v1.18.26 source proves that `run --format
json` emits `session.error` as a JSON `type=error` event on stdout and sets
exit code 1. Therefore the actual failure was available but was not promoted
into Runtime evidence.

Corrections:
- the executor now parses the terminal OpenCode JSON error event;
- only a bounded/redacted diagnostic projection is emitted:
  source, sessionId, errorName, errorCode, errorMessage, providerId and modelId;
- bearer/API-key/token/password-like values are redacted;
- `opencode.failure` is buffered by Rust and persisted by the semantic
  finalizer into `agent_events`;
- nonzero OpenCode exits now throw through the normal executor catch instead of
  calling `process.exit()` immediately, so the structured diagnostic is
  flushed before process termination;
- R-9 includes `opencode.failure` in its boundary diagnostics;
- R-9 now fails immediately when an upstream task becomes failed/blocked or the
  semantic run becomes terminal before the process-loss boundary, instead of
  waiting the 20-minute boundary timeout.

No provider configuration, model ID, OpenCode version, retry policy or network
allowlist was changed because this run does not yet identify which of those
caused the OpenCode session error.

## Scoped R-9 compiled OpenCode runtime correction

Scoped run `standalone-v1-1790117182742-551e1dd708ce` on candidate
`2031876a6b7451a12b79b3bf3c99d3848de35580` again proved Q-ENTRY,
PRE-R0 and R-0 through R-6 PASS. Product Discovery then entered the restricted
OpenCode executor, copied auth into the Runtime-owned ephemeral state root,
spawned OpenCode, observed a real session and failed all three attempts with:

`UnknownError: Unexpected server error. Check server logs for details.`

Technical Refinement was cancelled, so the physical worker-loss boundary never
materialized.

This rerun exposed two independent defects.

First, the R-9 pre-boundary fail-fast added by the preceding correction was not
actually terminal. `scripts/qualification/lib/util.mjs::waitFor()` caught every
predicate exception indiscriminately. The `QualificationHold` raised for the
failed semantic run was stored as `lastError` and retried until the full
20-minute `r9-process-loss-boundary` timeout expired.

Correction:
- `waitFor()` now accepts `shouldRetryError`;
- HOLD-capable R-7, R-9 and R-10 polling passes
  `shouldRetryQualificationPollError`;
- `QualificationHold` propagates immediately while ordinary transient polling
  errors retain the previous retry behavior;
- regression coverage proves a terminal predicate error is observed exactly
  once rather than converted into a timeout.

Second, the Runtime worker was still pinned to `opencode-ai@1.18.26`.
Upstream `anomalyco/opencode#50439` identified a compiled-build import cycle in
the filesystem search layer that can make every prompt fail in
`SystemPrompt.environment` before provider invocation with the same generic
`UnknownError / Unexpected server error` wrapper. The upstream fix was merged
as `f5ce4f881e477c7b75421cea2d20939f0ddd71fb` and is an ancestor of the
OpenCode `v1.18.32` release commit.

Correction:
- the Runtime worker now pins `opencode-ai@1.18.32`;
- no transport, model-routing, MCP, network, auth, retry-budget or fencing
  semantics are changed;
- structured `opencode.failure` evidence also retains the bounded
  `errorRef` when OpenCode exposes one, allowing direct correlation with
  ephemeral server logs if another internal failure occurs.

The generic error alone does not prove that the exact failed 1.18.26 process
hit that upstream import cycle, so the dependency root cause remains
fail-closed until the new exact SHA is rerun. The rerun must prove Product
Discovery progresses on 1.18.32 and Technical Refinement reaches
`repair-checkpoint-before-behavior`; otherwise the new structured diagnostic is
the authority for the next correction.

## Scoped R-9 errorRef diagnostic and Runtime config-authority closure

Scoped run `standalone-v1-1790119853659-6d1ea9afa5eb` on exact candidate
`15cf8ad84996fbf8f6edf5fc552043b71692cc03` proved Q-ENTRY, PRE-R0 and
R-0 through R-6 PASS again. The source pin had already moved the Runtime worker
Dockerfile to OpenCode 1.18.32, but Product Discovery still failed all three
attempts before Technical Refinement with the same generic server wrapper:

`UnknownError: Unexpected server error. Check server logs for details.`

This run materially improved the evidence. `opencode.failure` now carried
`errorRef=err_4a05fee2`, and the R-9 pre-boundary fail-fast fired as intended.
The gate completed in roughly 88 seconds rather than waiting the previous
20-minute process-loss-boundary timeout. Technical Refinement remained
`cancelled`, so no worker-loss fault was injected.

The prior `anomalyco/opencode#50439` compiled filesystem-cycle hypothesis is
therefore no longer sufficient to explain the Runtime failure. The exact
OpenCode 1.18.32 source pin did not move the observed failure class. The report
still exposed only the host OpenCode version in PRE-R0, so the next R-4 now
also executes `opencode --version` inside `agent-runtime-worker` and HOLDs
unless it is exactly 1.18.32.

Inspection of OpenCode 1.18.32 shows that this `UnknownError` is intentionally
a defect wrapper. The server generates `err_<id>`, writes the underlying
exception and pretty cause through `Effect.logError`, then exposes only the
generic 500 plus the reference. The Runtime therefore needs the correlated
server log rather than another retry or another guess at provider/model cause.

The child execution boundary is now hardened at the same time:

- OpenCode runs with `--pure` / `OPENCODE_PURE=1`; external consumer
  plugins cannot become Runtime execution authority, while OpenCode's built-in
  CodexAuthPlugin remains enabled for ChatGPT OAuth;
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` prevents consumer
  `opencode.json{,c}` and consumer `.opencode` directories from being
  discovered, while `OPENCODE_CONFIG_CONTENT` remains the final explicit
  Runtime-owned inline configuration;
- XDG data, state, config and cache roots all live below the attempt-scoped
  Runtime state root;
- inherited `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` are removed;
- OpenCode server logging is enabled only at ERROR level;
- raw OpenCode stderr is not forwarded into durable task logs;
- on nonzero exit, only the line matching the returned `errorRef` is selected,
  bounded and redacted for bearer/API credentials and prompt/input/body fields,
  then projected as `serverLogExcerpt` in `opencode.failure`.

This is both a diagnostic correction and an agnosticism correction: a consumer
repository may contain its own OpenCode configuration for its developers, but
that configuration must never silently modify a task already routed and
authorized by Agentic Harness Runtime V2.

The next exact-SHA scoped rerun has two valid outcomes:
1. Product Discovery progresses and Technical Refinement reaches
   `repair-checkpoint-before-behavior`, allowing the physical worker-loss
   qualification to continue; or
2. the run fails fast again, but `opencode.failure.serverLogExcerpt` exposes a
   bounded redacted internal cause correlated to its `errorRef`, which becomes
   the authority for the next repair.

## Scoped R-9 Runtime event wire-prefix correction

Scoped run `standalone-v1-1790128717557-b9c4c026224d` on exact candidate
`69ea9f72335cb496c8e03ee3115c2d2cde095ae0` proved Q-ENTRY, PRE-R0 and
R-0 through R-6 PASS. R-4 additionally proved the live
`agent-runtime-worker` OpenCode version is exactly `1.18.32`.

The restricted child also proved the intended isolation controls are active:
`pure=true`, `projectConfigDisabled=true`, attempt-scoped XDG roots,
`rawServerLogsForwarded=false`, and `serverLogLevel=ERROR`.

Product Discovery nevertheless failed all three attempts before Technical
Refinement. The new diagnostic path produced `errorRef=err_5b7f2078` and a
`serverLogExcerpt`, but the qualification report only retained the beginning:

`timestamp=2026-09-23T02:09:47.899Z level=ERROR run=de544389 mess...`

The underlying cause was still cut off.

Source inspection identified the reason. The two JavaScript executors use the
canonical wire marker:

`@@agentic-harness-runtime-event `

but `apps/runtime-worker/src/agent_runtime.rs::observe_runtime_event()`
expected:

`@@agent-harness-runtime-event `

The missing `ic` meant every structured event emitted by the restricted child
failed `strip_prefix` in the Rust execution plane. As a result:
- `opencode.session.observed` did not update the Rust-side session identity;
- `opencode.failure` was not added to
  `ExecutionTelemetry.runtimeEvents`;
- the semantic finalizer therefore could not persist the structured failure as
  an independent `agent_events` row;
- the failure remained only inside the bounded stderr summary / task error
  string, where the manifest and preceding events consumed the projection
  budget before the internal OpenCode cause.

Correction:
- the Rust parser now consumes the same
  `@@agentic-harness-runtime-event ` literal used by both JS emitters;
- an async Rust regression proves a canonical
  `opencode.session.observed` updates session identity and a canonical
  `opencode.failure` is buffered;
- the historical truncated marker is explicitly rejected so there is one
  authoritative wire format rather than two aliases;
- a cross-language Node contract locks the literal across
  `scripts/internal/opencode-task-executor.mjs`,
  `.agents/runtime/executor.mjs` and the Rust worker;
- R-9 now queries the latest persisted `opencode.failure` directly from
  `agent_events` and exposes it as the first-class `opencodeFailure`
  evidence object, independent of the long task `error_message`.

This correction is broader than diagnostics but narrower than task semantics:
it restores the structured child-to-Rust telemetry contract that was already
intended by the execution result schema and semantic finalizer. No routing,
provider, retry, behavior-gateway, fencing, cache, memory or continuation
policy changes.

The next exact-SHA run must prove that the structured event survives all the
way into `agent_events`. If Product Discovery still fails,
`firstDivergence.evidence.opencodeFailure.serverLogExcerpt` must contain the
bounded redacted internal OpenCode cause. If Product Discovery succeeds, R-9
continues to the physical worker-loss boundary.

## Scoped R-9 OpenAI OAuth active-provider catalog correction

Scoped run `standalone-v1-1790133421264-2896f2118cef` on exact candidate
`74f227a04445a28153499ae89542fb98a4f892f5` proved the previous Runtime
event transport correction. Q-ENTRY, PRE-R0 and R-0 through R-6 passed, R-4
proved live worker OpenCode `1.18.32`, and `opencode.failure` was persisted
as an independent `agent_events` row with
`source=rust-buffered-opencode-runtime-event`.

That made the underlying OpenCode error authoritative instead of inferred.
All three Product Discovery attempts failed before Technical Refinement with:

`ProviderModelNotFoundError: Model not found: openai/gpt-5.6-luna. Did you mean: gpt-5.6-luna, gpt-5.6-luna-pro, gpt-5.6-luna-fast?`

The `openai/` prefix in this message is not a duplicated model identifier.
OpenCode 1.18.32 parses `--model openai/gpt-5.6-luna` into
`providerID=openai` and `modelID=gpt-5.6-luna`, and
`ProviderModelNotFoundError` formats those two values back as
`<provider>/<model>`.

The diagnostic instead proves a catalog/provider-state split:
- the model exists in the unfiltered models.dev catalog, otherwise it could not
  be returned as an exact suggestion;
- the active ChatGPT OAuth provider projection used by `Provider.getModel()`
  does not contain the model;
- the restricted Runtime intentionally gives every attempt a fresh XDG cache;
- in OpenCode 1.18.32, ModelsDev population loads a disk cache first and then
  prefers the binary-embedded snapshot when the fresh cache has no
  `models.json`; it does not automatically fetch the current remote catalog
  merely because the cache is empty;
- upstream `anomalyco/opencode#47490` documents the same
  catalog-present/active-provider-missing failure class and verifies
  `opencode models openai --refresh` followed by a fresh provider process as
  recovery.

Correction:
- the Runtime route remains the qualified `openai/gpt-5.6-luna`; no model ID
  rewrite or allowlist bypass is introduced;
- immediately before the first prompt, the restricted executor runs
  `opencode --pure models openai` in the exact attempt environment;
- if the routed model is already present, execution proceeds without network
  refresh;
- only on miss, the executor runs exactly one
  `opencode --pure models openai --refresh`;
- the exact qualified model is revalidated after refresh;
- the same attempt-scoped XDG cache is then reused by the main prompt and all
  bounded structured repair/finalization calls;
- inherited `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_MODELS_PATH` and
  `OPENCODE_MODELS_URL` are removed from the restricted child so parent or
  consumer environment cannot silently redirect/freeze catalog authority;
- `opencode.model_catalog` records whether the selected model came from the
  active cache or a models.dev refresh;
- if the model remains absent after refresh, the executor fails before model
  invocation and emits a structured `opencode.failure`;
- persistent model-unavailable / `ProviderModelNotFoundError` failures are
  classified non-retryable so the Runtime cannot burn three identical full
  attempts on a deterministic provider-state miss.

This preserves model-routing authority while making provider metadata
self-healing at the narrow external-cache boundary. It does not change model
selection, ChatGPT OAuth credentials, retry routing, MCP, behavior-gateway,
fencing, semantic cache, ProjectMemory or continuation semantics.

The next exact-SHA run must show an `opencode.model_catalog` event with
`available=true`. On this host the expected path is a local miss followed by
one successful `models-dev-refresh`, after which Product Discovery should
reach the actual model request. If it still fails, the persisted
`opencode.failure` remains the authority for the next correction.

## Scoped R-9 provider refresh process-boundary correction

Scoped run `standalone-v1-1790135118676-f9a52b184033` on exact candidate
`1e301d1d3ef4774245906a6b5eb8a08193481c56` proved the previous
performance/fail-closed hardening but showed that the first catalog-refresh
correction stopped one lifecycle boundary too early.

Q-ENTRY, PRE-R0 and R-0 through R-6 passed. R-4 again proved live worker
OpenCode `1.18.32`. Product Discovery failed on **attempt 1 only** with
`opencode_provider_model_not_found`, `failureCategory=provider` and
`retryable=false`. This proves the deterministic provider miss no longer burns
the three-attempt task retry budget.

The persisted catalog event was:

- `modelId=openai/gpt-5.6-luna`
- `available=false`
- `refreshAttempted=true`
- `localStatus=1`
- `refreshStatus=1`
- `source=unavailable-after-refresh`

The previous implementation treated the provider/model list emitted by the
`models openai --refresh` process itself as the final post-refresh authority.
That is not equivalent to the upstream recovery sequence.

OpenCode 1.18.32 implements the command in two distinct phases: it refreshes the
models.dev disk cache and then obtains/lists provider state inside that command
process. A nonzero command result can therefore conflate the cache refresh with
a stale or inactive provider projection. Upstream
`anomalyco/opencode#47490` explicitly reports recovery only after
`opencode models openai --refresh` **followed by a fresh OpenCode process /
restart**.

The Runtime preflight is therefore corrected as follows:

1. run `opencode --pure auth list` in the exact isolated attempt environment;
2. record only bounded/redacted provider-level auth evidence;
3. run a local `opencode --pure models openai` selected-model probe;
4. on miss, execute exactly one
   `opencode --pure models openai --refresh`;
5. regardless of whether that refresh process can immediately list the provider,
   start a **new** `opencode --pure models openai` process with the same
   attempt-scoped XDG cache;
6. use only this fresh-process revalidation as final post-refresh model
   availability authority;
7. persist bounded/redacted diagnostics and status for auth, local probe,
   refresh and revalidation;
8. distinguish two fail-closed provider failures:
   - `ProviderAuthError / provider_credential_not_observed` when the isolated
     child cannot see the OpenAI credential at all;
   - `ProviderModelNotFoundError /
     model_unavailable_after_refresh_reload` when the credential is visible but
     the selected model is still absent after refresh plus fresh-process
     revalidation;
9. keep both failures non-retryable.

This retains `openai/gpt-5.6-luna` as the model-routing contract and does not
inject local model metadata or bypass the OpenCode OAuth provider filter. It
also avoids weakening the restricted UID network policy: public egress remains
available, while private control-plane CIDRs remain denied.

The next exact-SHA run now has a decisive diagnostic surface. If auth visibility
is false, the issue is credential projection/decoding. If auth visibility is
true but the fresh revalidation remains status 1, its bounded diagnostic is the
next authority. If the fresh process sees Luna, Product Discovery proceeds and
R-9 can finally reach the physical worker-loss boundary.

## Scoped R-9 qualification OAuth projection correction

Scoped run `standalone-v1-1790136315663-27738e9a0e30` on exact candidate
`6c331981347e77c048fbef014cc909b6dbc88636` proved the provider diagnostic
surface and exposed the actual qualification defect.

Q-ENTRY, PRE-R0 and R-0 through R-6 passed. R-4 again proved live worker
OpenCode `1.18.32`. Product Discovery failed exactly once with
`opencode_provider_auth_not_observed`, `retryable=false`.

The decisive evidence was:
- `authCopied=true` in the restricted child;
- `authStatus=0`;
- `authProviderCredentialObserved=false`;
- `authDiagnostic=0 credentials`;
- local and fresh-process provider probes both reported
  `Provider not found: openai`.

This is not contradictory. The Compose contract mounts:

`${AGENT_HARNESS_OPENCODE_AUTH_HOST_FILE:-./vendor/empty-opencode-auth.json}`

at `/root/.local/share/opencode/auth.json`. The qualification's
`buildConsumerEnv()` did not set
`AGENT_HARNESS_OPENCODE_AUTH_HOST_FILE`, so the worker received the intentional
empty fallback. Rust then correctly copied that file into the disposable model
HOME and the JS attempt isolation copied it again. Therefore
`authCopied=true` only proved byte/path propagation of an empty authority.

The earlier stale-provider/model-refresh interpretation is consequently
secondary. The qualification had never mounted the real OpenAI OAuth credential
into the worker.

Correction:
1. resolve the host OpenCode auth source from explicit
   `AGENT_HARNESS_OPENCODE_AUTH_HOST_FILE`, native
   `XDG_DATA_HOME/opencode/auth.json`, or the native user-home
   `.local/share/opencode/auth.json`;
2. validate only structural OpenAI OAuth properties before stack startup:
   `type=oauth`, non-empty `access` and `refresh`, and non-negative integer
   `expires`;
3. materialize a qualification-owned `auth.json` containing only the
   `openai` credential under a dedicated temporary directory with mode `0600`;
   the directory is removed during qualification cleanup/R-11 and is never part
   of the persisted report output;
4. inject that temporary path as
   `AGENT_HARNESS_OPENCODE_AUTH_HOST_FILE` before `harness up` /
   Docker Compose;
5. R-4 executes `opencode --pure auth list` inside
   `agent-runtime-worker` and HOLDs unless `OpenAI oauth` is visible;
6. R-4 report evidence records only source strategy and credential-shape
   booleans, never token values;
7. the restricted model preflight now stops immediately at
   `provider-credential-unavailable` when OAuth is not visible instead of
   spending the model-refresh timeout.

The generic Compose fallback remains unchanged and safe for deployments that
have not configured model credentials. The correction is scoped to
qualification authority: a live semantic qualification cannot claim to prove
OpenAI model execution while silently using the empty-auth fallback.

The next exact-SHA run must pass the new R-4 OpenAI OAuth proof before R-9 is
allowed to become meaningful. If R-4 passes, the Product Discovery child must
also observe the credential from its disposable HOME. Only then should catalog
refresh/reload evidence be interpreted as a model-provider issue.

## Scoped R-9 post-Product semantic progress correction

Scoped run `standalone-v1-1790137459096-b2f0cb6abc05` on exact candidate
`e6cdb2044deb61ad8f0100761ec5763eac80b03f` proved the prior OpenAI
qualification-auth correction end-to-end.

R-4 proved worker OpenCode `1.18.32`, `OpenAI oauth` inside the worker, and a
qualification-owned OpenAI credential shape with access/refresh/expiry present.
The restricted Product Discovery child independently observed that OAuth state,
found `openai/gpt-5.6-luna` in the active provider without refresh, and its
executor completed attempt 1 with exit code 0 in 82,853 ms.

The R-9 process-loss boundary nevertheless did not materialize within the
20-minute pre-boundary safety ceiling. At timeout the Technical Refinement task
was still:

`status=routed, attempt=0, dispatchGeneration=0, fencingToken=0`.

There was no `opencode.failure`.

That state proves Technical Refinement never reached
`dispatchPreparedTask()`, but it does **not** by itself prove a scheduler
deadlock. Product Discovery is the authority for bootstrap review selection.
After Product integration the refined topology may legitimately materialize
Architecture/Database/Infrastructure/etc. review tasks and make Technical
Refinement depend on them.

The previous R-9 evidence did not include:
- Product Discovery semantic terminal status (`task.integrated` versus only
  physical `executor.completed`);
- refined bootstrap topology state/authority/revision;
- materialized review tasks and their dependencies;
- pending execution results awaiting semantic finalization;
- reconcile generation/lease state;
- Runtime outbox publication/terminal state;
- scheduler dispatch decisions or reconcile failures.

The fixed 20-minute wait was therefore an observability defect: it could report
only "boundary not materialized" after a long wait without distinguishing
legitimate prerequisite execution from finalizer/refinement/scheduler stall.

Correction:
- R-9 now obtains one bounded semantic snapshot containing run
  status/state-version/reconcile-generation/lease plus bootstrap topology state;
- every task contributes status, attempt, generation, fence, dependencies,
  retry window and descriptor/handoff identity;
- pending execution results are visible separately from tasks;
- recent Runtime outbox entries expose kind, task/generation, publish count,
  published/terminal state and only a boolean for last-error presence;
- key semantic events include `task.integrated`, bootstrap refinement,
  materialized tasks, preparation/dispatch decisions, executor completion and
  reconcile failures;
- R-9 tracks a semantic progress fingerprint instead of treating elapsed
  wall-clock since run creation as progress;
- every 30 seconds it prints a compact task/topology progress line;
- if there is no semantic state change for 180 seconds, R-9 fails fast with
  `r9_pre_boundary_semantic_stall` **only** when there is no genuine
  `running` execution, no active reconcile lease and no future
  `retry_not_before` backoff;
- real model/review execution remains allowed to run and the original
  20-minute interval remains only an absolute safety ceiling.

This change is intentionally qualification-only. The current evidence is
insufficient to justify modifying the production DAG, bootstrap refinement or
scheduler. The next exact-SHA run will identify whether Product Discovery was
still awaiting semantic finalization, Product selected review prerequisites, or
the scheduler/reconciler stopped advancing. Only that evidence may authorize a
production repair.

## R-1 contract drift after the progress-aware R-9 refactor

Scoped run `standalone-v1-1790140282302-571e5b267ac6` on candidate
`99d6e8859660378040938a58d6038ddb831eb81c` stopped at R-1 before any
Runtime fault execution. Q-ENTRY, PRE-R0 and R-0 passed; `harness:test`
reported 490 tests with 488 pass and exactly two failures, both static
qualification-controller assertions for R-9.

Neither failure represented a production Runtime defect:

- the old contract required the literal negative guard
  `repairKind !== "qualification-process-loss"` plus
  `checkpoint.status !== "repair-started"`; the progress-aware R-9 now accepts
  the exact checkpoint using positive equality predicates inside the success
  branch;
- the old contract required a local `boundaryEvents` variable that no longer
  exists because timeout/failure evidence is now carried by the richer
  authoritative `semanticSnapshot`.

The contracts are corrected without weakening authority. They now require:
- `checkpoint.contractVersion === "runtime-repair-checkpoint/v1"`;
- `checkpoint.repairKind === "qualification-process-loss"`;
- `checkpoint.status === "repair-started"`;
- `checkpoint.qualificationBoundary === "repair-checkpoint-before-behavior"`;
- `r9SemanticSnapshot(runId)` and `semanticSnapshot: snapshot`;
- explicit inclusion of
  `qualification.process_loss_boundary_ready` and
  `runtime.reconcile_failed` in the semantic evidence catalog.

No scheduler, DAG, worker, gateway or production Runtime behavior changed for
this correction. R-2 through R-9 were not run by that qualification, and R-11
cleaned the environment while preserving exact HEAD/tree equality.

## Live R-9 scheduler bookkeeping-progress defect

Live Runtime observation `run-1efd1c35-097c-45dc-8064-4accf8b064e4` on
candidate `5f2348ea168c564df8d5d44cacab328bfeeea059` finally exposed the
post-Product topology that the earlier timeout report could not show.

The run progressed through:
- Product Discovery `routed -> running -> integrated`;
- topology `provisional -> refined`;
- Architecture Governance `running -> integrated`;
- Technical Refinement remained `routed(a0/g0)`.

After Architecture integrated, the compact state remained unchanged:
`pendingResults=0`, Runtime outbox count `9`, and Technical Refinement was
the only non-terminal task. Therefore the previous ambiguity about hidden
review prerequisites is gone: no additional review task existed in this
refined topology.

The intended 180-second semantic-stall watchdog nevertheless did not fire.
Source inspection found why:

1. `dispatchReadyTasks()` computed
   `peak = max(currentPeak, active + dispatched)`;
2. it called `updateRun({ peak_parallel: peak })` whenever `peak > 0`,
   even when `peak === currentPeak`;
3. every no-op update incremented `agent_runs.state_version`;
4. R-9's first semantic-progress fingerprint included `stateVersion`,
   `reconcileGeneration`, task `stateVersion` and outbox
   `publishCount`;
5. the 30-second repair sweep therefore manufactured apparent progress forever
   while the DAG itself did not advance.

Correction:
- `peak_parallel` is now persisted only when observed parallelism exceeds the
  previous peak;
- the R-9 progress fingerprint excludes bookkeeping-only
  `stateVersion`, `reconcileGeneration`, task `stateVersion` and
  `publishCount`;
- progress authority remains run status/topology revision, task
  lifecycle/attempt/generation/fence/dependencies/retry window, pending result
  identities and outbox published/terminal identities;
- compact progress output now prints each task dependency list and the latest
  `runtime.reconcile_failed` code/message when present;
- a row selected as ready but absent from the persisted plan now fails closed as
  `scheduler_ready_task_missing_plan` instead of silently returning null.

This fixes a real production bookkeeping bug and a qualification watchdog bug.
It does **not** yet guess why Technical Refinement failed to transition from
`routed` to `queued`. With Product and Architecture integrated,
`dependenciesSatisfied()` should select the Technical Lead. The remaining
boundary is therefore between ready-task selection and
`dispatchPreparedTask()` -- policy dispatch or task preparation. The next
exact-SHA run will expose that error directly through
`runtime.reconcile_failed` if it persists.

## Live R-9 Context Engine Git source-authority failure

Live Runtime run `run-d36f5e7b-53e9-40a3-b512-4c6472463695` on candidate
`c94ead03ee89d9fdd1813ba6009afd932eedeb82` proved that the preceding
progress-watchdog correction is working: after Product Discovery integrated,
the compact R-9 line exposed the exact Technical Refinement dependency and then
reported:

`reconcileFailure=source_git_command_failed:rev-parse`

The refined topology for this run contained only Product Discovery and
Technical Refinement, so no hidden review dependency was blocking dispatch.
Technical Refinement remained `routed(a0/g0)` because its semantic
preparation threw before `dispatchPreparedTask()`.

The failure is qualification-boundary-specific but originates from a real
Runtime image dependency:

1. WAVE-10 arms `qualification.behavior.delay` only for
   Technical Refinement attempt 1;
2. `prepareTaskExecution()` therefore calls
   `loadCommittedProjectConfiguration(repositoryRoot)` to derive immutable
   command authority for that behavior;
3. the committed-source loader in
   `packages/source-identity/src/git-snapshot.mjs` invokes Git directly
   (`rev-parse`, `ls-tree`, `cat-file`) and fails closed as
   `source_git_command_failed:<command>`;
4. the semantic controller runs from `apps/context-engine/Dockerfile`, based
   on `node:22-alpine`, and that image did not install Git;
5. the consumer repository itself is already correctly bind-mounted at
   `/workspace/repository`.

Product Discovery does not cross the qualification behavior command-authority
boundary, which is why real Luna execution and Product integration succeeded
before the failure first appeared at Technical Refinement.

Correction:
- install Git explicitly in the Context Engine image;
- make R-4 execute `git --version` inside the running Context Engine;
- make R-4 execute `rev-parse --show-toplevel` against
  `/workspace/repository`;
- make R-4 execute `rev-parse --verify HEAD^{commit}` there and compare it to
  the qualification consumer's host-observed commit;
- fail R-4 immediately on missing Git, wrong repository root or commit mismatch;
- retain the existing committed-source loader fail-closed semantics instead of
  converting source-authority failures into task retries.

This moves the proof of the semantic controller's Git/source authority to the
earliest live Runtime gate. A missing Git executable or an invalid repository
mount can no longer survive until Technical Refinement in R-9.

## R-9 physical behavior-window observation correction

Scoped qualification `standalone-v1-1790143830295-93b5d096be8c` on exact
candidate `38ca7013be090f8dd90bfeb2a759c5993090ccaf` proved the previous
Context Engine Git correction and advanced the fault boundary materially:

- R-4 proved Git `2.54.0` inside Context Engine, exact
  `/workspace/repository` top-level authority and exact consumer HEAD;
- Product Discovery integrated;
- Architecture Governance integrated;
- Technical Refinement reached `running(a1/g1)`;
- the durable process-loss checkpoint and `behavior.gateway.started` boundary
  were reached;
- R-9 then failed only while waiting 30 seconds for the named physical behavior
  container to report `Running`.

The qualification assumption at that point was too strong.
`behavior.gateway.started` is persisted by the Rust worker immediately before
`invoke_gateway()`; it does **not** mean the Docker behavior process has
started. The gateway still performs committed-source loading, workspace
binding, runner materialization, image attestation and toolchain verification
before launching `docker run`.

Those pre-container probes themselves have legal timeout envelopes of roughly
20 seconds for materialization, 10 seconds for attestation and 60 seconds for
toolchain verification. A 30-second physical-container observation window can
therefore fail against a healthy but slow gateway. Conversely, if the gateway
returns HOLD/FAILED during those probes, the old qualification waited for a
container that would never be created and then discarded the exact terminal
gateway status.

Correction:
- race exact named-container `Running` against the matching
  `behavior.gateway.completed` event;
- if the gateway terminates first, fail immediately with its exact status/code
  and semantic snapshot;
- use a 120-second bounded container-start observation so the qualification
  budget exceeds the gateway's pre-container probe envelope;
- on timeout, retain source `behavior.gateway.started`, exact matching
  completion if any, gateway liveness/restart identity and the full R-9 semantic
  snapshot;
- add `behavior.gateway.started` and `behavior.gateway.completed` to the
  semantic snapshot event catalog;
- apply the same terminal-aware 120-second observation contract to the
  replacement behavior after worker recovery.

This correction does not claim that the gateway itself failed in the observed
run. The old report did not preserve `behavior.gateway.completed`, so that
outcome is not recoverable from the qualification report. The next exact-SHA
run will distinguish a slow-but-valid preflight from an actual gateway HOLD
without another opaque procedure timeout.

## R-9 Product copy-workspace source-root isolation conflict

Scoped qualification `standalone-v1-1790204776362-8adf2778fd76` on exact
candidate `1d628e6e04c921ef2225086a035f3903d4fdc498` did not reach the
physical behavior-window observer. Q-ENTRY through R-6 passed, Context Engine
Git/source authority remained green, OpenAI OAuth remained visible and
`openai/gpt-5.6-luna` remained available without refresh.

Product Discovery executed successfully at the process/model layer
(`exitCode=0`, about 110 seconds) but semantic integration failed with:

`copy_integrate_root_changed:docs/specs/qualification/r9/PRD.md`

Technical Refinement was then correctly cancelled as `dependency_failed`.

The copy-workspace integration fence compares the raw SHA-256 and byte count
captured from the exact copied file at workspace materialization with the
current source-root file immediately before integration. Rust and JavaScript use
the same fingerprint contract. Therefore this is not mtime, file-mode or line
ending metadata drift: the source-root PRD changed in bytes after the Product
workspace fork.

The old report did not include the
`workspace.root_changed_since_fork` event, so the baseline/current hashes and
the exact external writer were lost when R-11 cleaned the qualification
consumer. The fixture assertion itself is read-only and no deterministic
Product post-processor writes the PRD, so attributing the external write to a
specific process would be unsupported.

Source inspection nevertheless exposed a real isolation gap:
- the model process ran with cwd/`--dir` set to the copy workspace;
- but it inherited
  `AGENT_HARNESS_PROJECT_ROOT=/workspace/repository`, directly naming the
  bind-mounted mutable source root;
- the Runtime child override denied only `question`; OpenCode 1.18.32 leaves
  `external_directory` at its default `ask`;
- OpenCode 1.18.32 enforces `external_directory` for path-aware tools and
  structured external workdirs, but absolute path tokens embedded in Bash
  commands are advisory rather than a sandbox boundary.

Correction:
- the OpenCode model child now receives
  `AGENT_HARNESS_PROJECT_ROOT=<execution copy workspace>` and
  `AGENT_HARNESS_AGENT_WORKSPACE=<execution copy workspace>`;
- the Runtime wrapper itself retains source-root authority for durable
  `.runtime` artifacts, so this is a model-facing authority projection rather
  than a storage relocation;
- every Runtime model child explicitly denies `external_directory`;
- Product Discovery, registered bootstrap governance reviews and Technical
  Refinement additionally deny Bash because these stages create semantic
  contracts and have no model-owned implementation/validation shell
  requirement;
- implementation stages retain Bash but still see the isolated workspace as
  project root;
- `copy_integrate_root_changed` remains unchanged as the final optimistic
  concurrency fence;
- R-9 semantic snapshots now include
  `workspace.root_changed_since_fork` and
  `workspace.integration_materialization_mismatch`, preserving fingerprints
  if any future root mutation occurs.

This correction intentionally does not claim that the Product model was the
writer in the observed run. The exact writer was not preserved. It closes the
model-child source-root authority gap and improves evidence so a recurrent
conflict becomes attributable rather than opaque.

## R-9 qualification module-initialization ordering defect

Scoped qualification `standalone-v1-1790206889388-86c9b7b23598` on exact
candidate `18778a7978bb7d1bf6077a2d97a7298a90c61505` passed Q-ENTRY through
R-6 and advanced R-9 far enough to execute the new source behavior
physical-window observer. That progression also shows that the preceding
Product copy-workspace isolation hardening no longer failed at Product
integration in this run.

R-9 then failed as a qualification-procedure error with:

`ReferenceError: Cannot access 'R9_BEHAVIOR_CONTAINER_START_TIMEOUT_MS' before initialization`

The defect was module execution ordering, not Runtime behavior.

`standalone-v1.mjs` started its gate loop through top-level `await` near the
top of the module. Function declarations such as `r9()` are hoisted, so R-9
could be invoked from that early loop. However, these later module-scope
declarations had not yet initialized:

- `R9_PRE_BOUNDARY_SEMANTIC_STALL_MS`;
- `R9_BEHAVIOR_CONTAINER_START_TIMEOUT_MS`.

Those `const` bindings therefore remained in JavaScript's temporal dead zone
until module evaluation reached their declarations. R-9 reached the physical
window and evaluated the second binding before initialization.

Correction:
- gate execution, cleanup and report emission are now owned by
  `executeQualification()`;
- defining that function does not execute qualification during early module
  evaluation;
- `await executeQualification()` is the final module statement, after all
  module-scope constants and function declarations have initialized;
- a qualification-controller contract requires both R-9 constants and the
  `selfTest` declaration to occur before the final dispatcher call and
  requires the module to end with that call.

This is deliberately a structural fix rather than moving one timeout constant
upward. Future gate constants may now be declared alongside the code that owns
them without being observable from a prematurely executing top-level gate loop.

No scheduler, Runtime worker, gateway, fencing, model-routing or project
isolation semantics changed in this correction.

## R-9 execution-fence RFC3339 interoperability defect

Scoped qualification `standalone-v1-1790207852309-551e39f2e161` on exact
candidate `de3beab247c17a91341e3583be581fef5c4e151f` proved the preceding
module-initialization correction and reached the actual behavior admission
boundary.

The run progressed through Product integration and Technical Refinement
`running(a1/g1)`, materialized the durable
`qualification-process-loss` repair checkpoint, emitted
`behavior.gateway.started`, and then received a terminal gateway result:

`HOLD / behavior_not_authorized`

before a physical behavior container was created.

The gateway had already passed committed configuration loading, command
authority matching, workspace binding, runner materialization, image
attestation and toolchain verification. The qualification fixture also uses the
supported behavior subset: one-off Docker execution, behavior phase,
`networkPolicy=none`, `effects=["read-only"]`, no secrets/env allowlist,
`dependencyPolicy=none`, and `validationScope=workspace`.

The remaining admission-specific failure was the task execution fence.

The Rust worker creates fence timestamps using
`chrono::DateTime::to_rfc3339()`. Valid values therefore use standard RFC3339
wire forms such as:

`2026-09-24T00:10:59.868143637+00:00`

The JavaScript contract in
`packages/harness-contracts/src/execution-fence.mjs` instead required:

`new Date(value).toISOString() === value`

That accepts only JavaScript's own canonical millisecond UTC representation,
for example:

`2026-09-24T00:10:59.868Z`

The Rust value represented the same valid instant but failed the byte-equality
test. `evaluateBehaviorAdmission()` therefore added
`task-execution-fence-invalid`; the behavior executor returned its generic
outer receipt code `behavior_not_authorized`.

Correction:
- RFC3339, not `Date.toISOString()` byte shape, is now the cross-runtime wire
  contract;
- the JS validator requires a strict RFC3339 timestamp with `Z` or numeric
  offset and optional 1-9 fractional digits;
- after wire validation the timestamp is canonicalized to
  `Date.toISOString()` for deterministic downstream comparisons;
- date-only/non-RFC3339 values remain fail-closed;
- contract coverage includes the exact Rust/Chrono shape with
  `+00:00` and nanosecond precision;
- `BehaviorGatewayResult` now extracts receipt
  `admission.reasons`, and `behavior.gateway.completed` persists them as
  `admissionReasons`.

The diagnostic hardening keeps the existing outer gateway code stable while
making future authorization HOLDs attributable without reading transient
container logs.

No change was made to behavior capability HMACs, worker fencing identity,
policy grants, runner source attestation, or the physical worker-loss procedure.

## R-9 replacement physical-window ordering and compiled-DAG schema defects

Scoped qualification `standalone-v1-1790209324670-99163966291b` on exact
candidate `b62819b19ceca11740668f43314f3f5d9729c8a5` advanced through the
physical worker-loss boundary and proved the prior RFC3339 fence correction.

The replacement execution was observed at the same semantic attempt with
`dispatchGeneration=2` and `fencingToken=2`. Its behavior gateway completed
`PASSED / docker_gateway_behavior_passed` with an empty
`admissionReasons` array, proving that the replacement fence, capability,
source authority, workspace binding, materialization, image attestation,
toolchain and behavior admission were accepted.

R-9 nevertheless reported
`r9_replacement_behavior_gateway_completed_before_physical_window`.
The qualifier discovered replacement identity by waiting first for
`repair.resume_checkpoint_loaded`. That event is not a live worker event: the
model child writes the durable resume receipt early, but the semantic controller
projects `repair.resume_checkpoint_loaded` only from
`finalizeExecutionResult()`, after the replacement executor has completed.
By then the 15-second qualification behavior had already finished and
`docker run --rm` had removed the named container.

Correction:
- detect replacement identity directly from the authoritative `agent_tasks`
  row while it is `running`;
- require the same semantic attempt and exactly
  `dispatchGeneration = source + 1`, `fencingToken = source + 1`;
- observe the matching `behavior.gateway.started` and named physical container
  while the replacement executor is in flight;
- prove behavior completion and container removal;
- only then require `repair.resume_checkpoint_loaded` with the exact
  replacement identity, `skippedFullAgentInvocation=true`,
  `sameTaskAttempt=true`, and the original checkpoint effect key.

The same run exposed an independent schema drift after replacement behavior
passed. Technical Refinement finalization failed with
`implementation_plan_invalid` because compiled implementation tasks contained
`validationCommandIds`, `commandSpecIds`, and `commandAuthority`, while
`execution-plan.schema.json` still rejected those fields through
`additionalProperties=false`.

Those fields are intentional Runtime authority: the DAG compiler projects them
and task preparation/context building consumes them. The execution-plan task
schema now declares all three explicitly using the same identity/authority
contracts already used by the implementation-plan schema. Strict
`additionalProperties=false` remains unchanged.

## Focused R-9 replacement identity contract drift

After the replacement physical-window observer was reordered, the focused
qualification-controller contract still asserted the previous receipt-first
source form. The failing assertion expected
`payload.dispatchGeneration !== target.dispatchGeneration + 1`, even though
the qualifier now derives replacement identity directly from the authoritative
`agent_tasks` row while the replacement is `running`.

The contract is aligned to the current stronger sequence:
- replacement task status is `running`;
- semantic attempt is unchanged;
- dispatch generation and fencing token are exactly source + 1;
- the named replacement behavior physical window is observed next;
- only after behavior completion/removal does R-9 require
  `repair.resume_checkpoint_loaded`;
- that receipt must prove `skippedFullAgentInvocation=true`,
  `sameTaskAttempt=true`, and the original checkpoint effect key.

No Runtime or qualification production semantics changed in this correction.

## Wave-10 scoped worker-loss qualification GREEN

Exact scoped qualification on harness source
`2ab7fcb94fc74387f1da6f5ea1d614521ea02469` completed successfully:

- run: `standalone-v1-1790211029105-836ef25cbfb9`;
- scope: `wave10-worker-loss`;
- verdict: `PASS`;
- `promotionEligible=false` by design;
- `firstDivergence=null`.

The live progress reached the complete scoped recovery path and then returned to
normal semantic execution:

- Product Discovery integrated;
- Technical Refinement crossed the physical worker-loss/replacement boundary;
- implementation work integrated;
- Quality Assurance reached verified;
- Product Acceptance completed;
- the scoped qualification closed without divergence.

This PASS closes the Wave-10 worker-loss target on one exact SHA. Historical RED
entries that remained marked "pending rerun" are superseded by this exact-SHA
green result.

It is **not** release promotion. The scoped mode intentionally excludes
R-7/R-8/R-10 and leaves the release `MANIFEST.json` closure to T17.

## Remaining release promotion gates

1. complete the scoped-green documentation closure, regenerate
   `MANIFEST.json` from the final tracked source with
   `scripts/internal/source-manifest.mjs --write`, and commit the manifest;
2. run the standalone controller **without** `--wave10-worker-loss` on that
   exact MANIFEST-closed SHA and require full `promotionEligible=true` PASS,
   including the R-7/R-8/R-10 gates omitted by the scoped qualification;
3. only after that full promotion PASS, move the Clip Compass qualified
   `.harness` gitlink/lock/certificate to the exact promoted harness SHA.

Until step 3, Clip Compass remains on the prior qualified harness release and
the current Wave-10 green SHA is evidence for the scoped target, not a release
pin.
