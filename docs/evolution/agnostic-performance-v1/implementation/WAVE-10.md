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

## Remaining promotion gates

WAVE-10 remains fail-closed and is not promoted until all of the following are
green on one exact source SHA:

1. focused Node syntax/contracts;
2. Rust fmt and `cargo test --locked`;
3. `docker compose --profile runtime --profile behavior-gateway config`;
4. exact-SHA Docker contract target;
5. exact-SHA `agent-runtime-worker` and `docker-behavior-gateway` builds;
6. normal non-behavior model task regression under UID 10001;
7. end-to-end typed behavior task using a WAVE-08 source-attested runner image;
8. live in-flight fence replacement proving the named behavior container is
   removed and the old receipt cannot become authoritative;
9. gateway outage and PostgreSQL outage proving deterministic HOLD/fail-closed;
10. physical worker process loss while behavior execution is in-flight, proving
    client-disconnect revocation plus replacement-fence recovery;
11. no regression in existing L1/L2, semantic cache, ProjectMemory, model routing,
    durable continuation or Runtime qualification.

A dedicated least-privilege PostgreSQL role for the gateway remains optional
defense-in-depth: the gateway already owns the Docker socket and the model UID
cannot reach the private control-plane network. It is not used as a substitute
for any gate above.

No main or consumer qualified pin is changed by this wave. Clip Compass adoption
remains pending until WAVE-10 target qualification is green; its qualified
`.harness` pin/lock/certificate stays on the prior qualified release until T17
produces the next exact qualified harness release.
