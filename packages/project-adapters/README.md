# Project adapters — wave 02

Implemented: strict ProjectDescriptor/CommandSpec contracts, bounded local marker
inspection, explicit Docker command planning, and read-only Docker identity
observation. Native launch is used only for the read-only identity probe. No
project command executes, no SDK is installed and no provider/model is called.

This is a T01/T03 slice, NOT completion of T03 or integration of T04/T13.
There is no new `harness:*` alias or active .agents schema replacement. Root
package/lock registration is reserved for T13. Existing cache/memory and promoted
consumer pin are unchanged.

## Interfaces

`validateProjectDescriptor`, `validateCommandSpec`, `projectDescriptorDigest` in
`packages/harness-contracts/src/project-descriptor.mjs` validate and clone bounded
JSON-shaped declarations. Object-key order does not change identity; ordered
arrays (including Compose overlays) remain ordered. projectId/repositoryId are
required caller-assigned stable IDs, never basename-derived. This prevents an
implicit collision fallback; it does not authenticate IDs supplied by callers.
Language names remain extensible; runner kind in this first slice is the resolved
DockerRunnerRef/v1 from wave 01. Native/Windows-container runner support remains
pending; there is no silent host fallback.

CommandSpec declares moduleId/runnerId, toolchain or behavior phase, executable,
argv, repository-relative cwd, public env key names, opaque secretRefs,
capabilities, network policy, effects, timeout, dependency policy and scope.
Executable shell wrappers are deliberately unsupported in this slice. Arbitrary
argv entries are preserved as distinct arguments, not concatenated shell text.
These checks are not an OS sandbox: `python -c`, scripts or a service entrypoint
can have effects. No declaration is permission to execute them.

`discoverProject(root,{projectId,repositoryId,moduleRoots})` reads only known
metadata filenames in explicit module directories. Recognizes Node, Python,
Rust, Go, JVM, .NET project markers and README docs; it does not parse every
language's build grammar or recursively guess monorepo roots. A marker is a hint,
not a claim of toolchain availability, complete project support or absence of
other languages. Python metadata alone does not authorize or infer pytest.
Node validation script names can yield suggestions, but script bodies are never
executed or emitted. Missing Node metadata never invents npm. Conflicting package
manager declarations/locks stay unresolved.

Discovery defaults: at most 128 module roots, 4096 directory entries, 64 selected
markers per module, 256 KiB per metadata file; descriptor loading permits 1 MiB.
Larger metadata/locks currently return an explicit quota error; they are not
silently truncated. .env files/private/reserved module paths are not inspected;
symlink ancestors/files and hardlinked metadata are rejected. Reads compare
file identity/size/times before and after. This guards ordinary drift but is NOT
a race-proof sandbox against an adversary concurrently rewriting directories;
execution still needs an authorized frozen workspace/source snapshot.

`loadProjectDescriptor(root)` reads `.agent-harness/project.json`, rejects invalid
UTF-8, duplicate JSON keys/deep nesting/unknown fields and returns a structural
identity. It never writes a descriptor or marks policy approved.

`planDockerCommand(descriptor,id)` emits a native argv plan for the exact declared
context/project/files/profiles/service/replica/user/cwd. Exec and one-off stay
distinct. One-off has `--pull never`, no implicit build, and `--no-deps` only for an
explicit dependencyPolicy=none. It returns executableNow=false and required gates
for source/config/mounts, policy, workspace, environment, effects/network, instance
or entrypoint, and toolchain evidence for behavior actions. It does NOT enforce
network/secret policy or permissions itself. Consumers MUST NOT dispatch that
argv until the future admission/executor completes those gates.

`probeDockerIdentity(runner,{root,timeoutMs})` uses only Docker info, image inspect,
engine ps with exact Compose label filters and selected container inspect fields.
It deliberately does not evaluate Compose YAML, includes or environment files.
It runs relative to the explicit
project root and respects a total deadline with bounded per-call output/time.
It checks daemon/image/platform, exact Compose labels/replica, running state,
restarts and membership drift. It does not emit inspect/env dumps or raw stderr.
A matched observation is PARTIAL: configurationVerified/sourceSnapshotVerified/
mountsVerified/trustVerified=false, toolchain/behavior=NOT_RUN and no qualification
verdict. It is a point-in-time identity observation, not future liveness or a
capability token. Docker unavailable/ambiguous/drifting yields HOLD without trying
host Python/Cargo/Node as product toolchains. One-off observation never creates
an instance. A wrong working directory is not repaired by searching containers
by name substring.

## Read-only CLI (implemented)

```sh
node packages/project-adapters/bin/inspect.mjs --root /path/to/project \
  --project-id project-a --repository-id repository-a --module services/api
```

With an independently resolved descriptor already in `.agent-harness/project.json`:

```sh
node packages/project-adapters/bin/inspect.mjs --root /path/to/project --command unit
node packages/project-adapters/bin/inspect.mjs --root /path/to/project --command unit --docker-identity
```

The last form explicitly opts into read-only Docker access. Without that flag
no process is spawned. The command-plan CLI omits raw invocation/argv. Exit 0
means inspection/plan construction or PARTIAL observation succeeded, NEVER that
project tests/toolchain/qualification passed. HOLD/invalid input exits 2. Raw
source, argv and secret values must not be placed in logs. Descriptors must hold
public values and opaque secret refs only; structural validation cannot recognize
a secret disguised as ordinary string data. Secret resolution/trust enforcement
remain future gates.

## Docker validation target

The dedicated Dockerfile tests these controller libraries and uses controlled
Docker responses in tests. It does not mount a Docker socket or pretend to test
a live product daemon. A real Docker probe matrix (correct/wrong image, replica,
restart, overlays, workspace) and product toolchain/import/test execution remain
NOT_RUN until performed on the declared target.

```sh
git archive --format=tar HEAD packages/harness-contracts/src \
  packages/source-identity/src packages/source-identity/bin \
  packages/project-adapters/src packages/project-adapters/bin \
  packages/project-adapters/Dockerfile scripts/internal/source-manifest.mjs \
  tests/contracts/portable-contracts.test.mjs tests/contracts/source-identity-v2.test.mjs \
  tests/contracts/project-descriptor.test.mjs \
| docker build --target test -f packages/project-adapters/Dockerfile -t harness-project-tests:wave02 -
# Resolve image ID, then use that ID instead of trusting the mutable tag.
IMAGE_ID=$(docker image inspect --format '{{.Id}}' harness-project-tests:wave02)
MSYS_NO_PATHCONV=1 docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges=true --pids-limit 128 --cpus 2 --memory 512m "$IMAGE_ID"
```

Use pipefail when collecting logs. No host checkout/credentials are build context
or runtime mounts. The base tag is not a receipt identity; capture resolved image,
Docker context and test output. No runtime/consumer certificate is created.

## Remaining gates

Trusted descriptor/policy admission, full adapter/toolchain conformance, approved
execution, env-file/mount/entrypoint resolution, network enforcement, active schema
integration, Docker target and Windows validation, and consumer adoption are still
pending. Preserve P01–P16 and do not update .harness/locks for this unqualified wave.


## Wave 04 committed configuration trust

The v2 path is intentionally separate from the legacy v1 runner contract.

- ProjectDescriptor/v2 stores DockerRunnerSpec/v2 only.
- Materialized source/daemon/image/mount hashes are outside the descriptor.
- `trust-config.mjs` reads descriptor and policy from immutable Git blobs.
- A committed source/policy match upgrades a command only to
  `SOURCE_POLICY_TRUSTED`; it is still not executable.
- Source binding hashes declared Compose/dependency files from the same commit.
- `record-only` source symlink identity records link bytes without authorizing
  filesystem dereference.

Read-only inspection:

```sh
node packages/project-adapters/bin/trust-config.mjs --root /path/to/project
node packages/project-adapters/bin/trust-config.mjs --root /path/to/project --command unit
```

The CLI does not emit CommandSpec argv/executable, does not call Docker, does not
check a mutable workspace, and does not produce qualification. Live
DockerRunnerMaterialization, task-workspace binding and behavior execution remain
later gates.


## Wave 05 workspace/materialization/toolchain chain

Wave 05 keeps command execution disabled while joining the previously separate
authority observations:

1. `bindWorkspaceAuthorityInputs(root, committedConfiguration)` checks only the
   immutable authority inputs in the mutable task workspace: descriptor, policy,
   declared Compose files and declared dependency files. Owned implementation
   files may change. The observation is point-in-time and is not a capability.
2. `probeDockerRunnerMaterialization({spec,sourceBinding})` performs read-only
   Docker observations and binds daemon, immutable image, public container config,
   a redacted mount projection and exact Compose container identity to the source
   binding. Raw bind source paths and env values are not emitted.
3. `probeDockerToolchainV2` uses fixed adapter-owned version probes. For an
   `exec` runner it executes inside the exact observed container ID. For a
   `one-off` runner it uses the immutable image with no network, read-only root,
   dropped capabilities and no-new-privileges. It never executes CommandSpec argv.
   The runner is re-observed afterward; replacement/restart/config changes reject
   the receipt.
4. `evaluateCommandReadiness` can reach `TOOLCHAIN_READY` only when committed
   source/policy, workspace authority inputs, materialization and toolchain receipt
   all refer to the same project/source/runner. Even then:
   `effectsEnforced=false`, `networkEnforced=false`,
   `secretsResolved=false`, `behaviorAuthorized=false`,
   `executableNow=false`.

This is intentionally not the behavior-command executor. T04 still needs to wire
command IDs into Technical Refinement and later enforcement must resolve
effects/network/secrets immediately before execution under a workspace lease.

The dedicated Docker test target now includes
`tests/contracts/command-readiness-v2.test.mjs`. Those tests use controlled
Docker responses; a real target-host materialization/toolchain run remains a
separate operational proof.


## Wave 07 committed CommandSpec authority and bounded behavior execution

Wave 07 introduces the first real `ProjectDescriptor/v2 CommandSpec.id` path into
Technical Refinement while retaining the legacy validation-string bridge for
projects that have not adopted committed v2 configuration.

`buildCommittedCommandSpecCatalog(workspace)` reads only committed
`.agent-harness/project.json` authority. A non-Git/legacy workspace yields an
empty catalog. A committed but invalid v2 configuration fails closed rather than
falling back to model-authored strings.

Technical Refinement may now emit `commandSpecIds`. Dynamic structured-output
schemas restrict them to committed IDs. Unknown IDs are deterministic plan
issues. DAG compilation and Task Briefs carry those IDs as semantic references;
they are not capability tokens and do not replace independent Runtime admission.

`evaluateBehaviorAdmission` joins the WAVE-05 source/policy/workspace/
materialization/toolchain chain with the exact CommandSpec. The first executable
subset is intentionally narrow:

- runner operation = `one-off`;
- phase = `behavior`;
- networkPolicy = `none`;
- effects = exactly `["read-only"]`;
- no secretRefs;
- no envAllowlist;
- dependencyPolicy = `none`;
- validationScope = `workspace` or `container`.

Existing `exec` services stay HOLD because Docker exec inherits the service's
network, environment and mounts; the Runtime does not claim effects/network/
secret isolation it cannot prove.

`executeDockerBehaviorCommandV2` uses native argv, immutable image ID,
`--pull never --network none --read-only --cap-drop ALL
--security-opt no-new-privileges`, fixed user/workdir and CommandSpec
executable/argv. No shell is introduced. Raw stdout/stderr are not returned;
only bounded byte counts and SHA-256 evidence are emitted. The runner is
re-observed after execution and identity drift invalidates the receipt.

This library is not yet wired automatically into the active Runtime executor.
Existing runs therefore retain their current semantics until the next integration
slice. The Docker foundation target includes
`tests/contracts/command-spec-execution-v2.test.mjs`.


## Wave 07 Docker target packaging correction

The WAVE-07 integrated contract tests import active Runtime planning modules
(`.agents/runtime/**`) and read active JSON Schemas (`.agents/schemas/**`).
The Docker target therefore must receive those committed paths in its build
context and copy them into the image. Omitting them can make package-local tests
pass while integrated test files fail at ESM module resolution.

Current archive context:

```sh
git archive --format=tar HEAD \
  .agents/runtime \
  .agents/schemas \
  packages/harness-contracts/src \
  packages/source-identity/src \
  packages/source-identity/bin \
  packages/project-adapters/src \
  packages/project-adapters/bin \
  packages/project-adapters/Dockerfile \
  scripts/internal/source-manifest.mjs \
  tests/contracts/portable-contracts.test.mjs \
  tests/contracts/source-identity-v2.test.mjs \
  tests/contracts/project-descriptor.test.mjs \
  tests/contracts/command-admission-v2.test.mjs \
  tests/contracts/trusted-project-config-v2.test.mjs \
  tests/contracts/command-readiness-v2.test.mjs \
  tests/contracts/validation-command-authority-v2.test.mjs \
  tests/contracts/command-spec-execution-v2.test.mjs
```

This expands only the deterministic test build context. It does not mount host
credentials, Docker sockets, product runtime state or consumer source into the
test container.


## Wave 08 image/source attestation and task fencing

Before active Runtime integration, behavior execution now requires two additional
proofs:

1. `docker-image-source-attestation/v1`: the materialized image must expose
   exactly the expected source snapshot, runner-spec digest and source-binding
   digest through the dedicated `org.agentic-harness.*` image labels. This
   prevents a digest-pinned but stale/unrelated image from becoming validation
   authority merely because its toolchain is healthy.
2. `task-execution-fence/v1`: run/task/attempt/dispatchGeneration/fencingToken
   and lease owner must still identify an unexpired running task.

`probeDockerImageSourceAttestation` queries only the exact image ID and the
three authority labels. Missing or mismatched labels return HOLD; the probe does
not emit arbitrary image metadata.

`.agents/runtime/behavior-fence.mjs` observes the authoritative task row through
the existing Runtime store. `executeBehaviorUnderTaskFence` checks the same
fence immediately before and after behavior execution. Heartbeat lease-expiry
extension is allowed without changing fence identity; replacement generation,
fencing token or lease owner invalidates the receipt.

The WAVE-07 behavior executor now requires both a valid image/source attestation
and an active execution fence. This hardening is still a library seam: the active
Rust worker is not yet dispatching behavior execution automatically. That final
bridge must retain worker heartbeat/cancellation supervision and must not expose
Docker socket authority to model-controlled processes.
