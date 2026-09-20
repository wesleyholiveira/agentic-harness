# Source identity foundation (T01/T02 — wave 01)

Implemented as dependency-free ESM modules. No new workspace package manifest or
root lock change; package registration remains with the integration task T13.
No application cache, database, worker, provider route, or consumer pin is changed.

## Implemented APIs

- `src/codec.mjs`: canonical v1 file records/verification, and an independent v2
  committed-source identity that binds path, byte digest, mode, kind and gitlink.
- `src/git-snapshot.mjs`: bounded raw Git object reading using one `ls-tree`, one
  `cat-file --batch-check` and one `cat-file --batch`; no per-file `git show`.
- `bin/verify.mjs`: read-only CLI. Default verifies a v1 manifest against committed
  blobs and a byte-exact clean worktree. `--snapshot` inspects committed source only.
- The official `scripts/internal/source-manifest.mjs` now calls the common v1 codec.
  It still emits the existing v1 distribution format; v2 distribution/pin rollout
  has NOT been activated.

```bash
node packages/source-identity/bin/verify.mjs --root . --snapshot
node packages/source-identity/bin/verify.mjs --root . --commit FULL_COMMIT_SHA
```

The second command requires a current generated/committed distribution manifest.
The historical documentation-only commits have not acquired new qualification by
adding this library. Neither CLI mode is a release or toolchain certificate.

## Explicit boundaries

Legacy v1 array order remains authoritative. Property insertion order does not.
v2 uses UTF-8 byte sorting (no locale collation). Unicode content and CRLF are not
normalized. Portable path policy rejects control characters, traversal, Windows
reserved names/characters and case/NFC-colliding paths. Git SHA-1 and SHA-256 are
supported. Gitlinks bind the commit object ID without inventing submodule bytes.

Symlinks are rejected by default. Explicit `internal-file` policy supports only
links directly to regular files in the same declared tree. Directory links,
chains, broken links and escapes are rejected, not silently traversed. The v1
writer cannot represent symlinks/gitlinks and now rejects them explicitly.

Snapshot mode reads immutable committed bytes and does NOT check the worktree.
The compatibility verifier checks HEAD, index and physical bytes independently
of assume-unchanged/skip-worktree and clean filters. It rejects filtered or CRLF
checkouts that are not byte-identical, instead of pretending a raw installation
was verified. v1 lacks mode metadata; `modeBound=false` documents that limitation.
A caller still needs a workspace lease against concurrent writes and an approved
source/secret-egress policy. This library is not a secret scanner or trust store.

Default resource limits: 100,000 entries, 32 MiB per Git object, 256 MiB total
object bytes and 16 MiB metadata; overflow fails explicitly. No lazy object fetch,
provider call, checkout, reset, mutation, or process per source file is performed.

## Docker test target

This target tests THESE libraries and the host-side manifest generator. It does
not prove the product's Python/ML toolchain, the Context Engine service, or a live
worker. It uses the Node 22 family already declared in the Context Engine recipe.
Image and Git package versions are observed when materialized; a tag is not proof.
Only selected public source/test files are copied (no .git, secrets or volumes).

From the harness root, after synchronizing the implementation commit:

```bash
TAG="agentic-harness-foundation-tests:$(git rev-parse --short=12 HEAD)"
docker build --target test -f packages/source-identity/Dockerfile -t "$TAG" .
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$TAG")"
printf '%s\n' "$IMAGE_ID"
MSYS_NO_PATHCONV=1 docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges=true \
  --pids-limit 128 --cpus 2 --memory 512m "$IMAGE_ID"
```

The MSYS override is scoped to that Docker run only and there are no host bind
paths to convert. Build may fetch toolchain dependencies; running the tests has no
network. No application stack, socket mount, privileged mode or global cleanup.
A missing Docker daemon is a missing Docker proof, not permission to silently
replace it with host SDK evidence.

In the implementation sandbox the pure Node/Git tests were executed; Docker was
unavailable. Run the target above before claiming container validation.
