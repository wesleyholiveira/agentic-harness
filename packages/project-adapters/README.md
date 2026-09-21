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
