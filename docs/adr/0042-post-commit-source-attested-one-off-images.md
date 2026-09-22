# ADR 0042 — Post-commit source-attested one-off images

**Status:** Accepted  
**Date:** 2026-09-21  
**Scope:** WAVE-10 typed behavior execution

## Context

WAVE-08 introduced Docker image/source attestation using three immutable authority labels:

- `org.agentic-harness.source-snapshot-sha256`;
- `org.agentic-harness.runner-spec-digest`;
- `org.agentic-harness.source-binding-digest`.

The original one-off runner contract required `image.mode=pinned-reference` with a registry digest embedded in the committed ProjectDescriptor. That is valid for an externally produced immutable image, but it is not a constructible contract for an image built from the same consumer source:

1. the committed descriptor contains the image digest;
2. the source snapshot includes that descriptor;
3. the source-binding and runner digests are derived from that committed source/spec;
4. those digests are stamped into image labels;
5. changing image labels changes the image digest required by step 1.

The local source-attested build path therefore had a self-reference. Static fixtures could model it with fake hashes, but no deterministic target-host build pipeline could materialize it.

## Decision

Add `image.mode=source-attested-build` for one-off Docker runners.

For this mode:

- `image.reference` MUST be `null`;
- `buildTarget` MUST be declared;
- the ProjectDescriptor is committed before the image is built;
- the trusted builder derives `sourceSnapshotSha256`, `runnerSpecDigest`, and `sourceBindingDigest` from that immutable commit;
- the builder stamps those three values into the image;
- materialization searches the configured Docker context for images matching all three labels;
- zero matches is HOLD;
- more than one distinct immutable image ID is HOLD;
- exactly one match is inspected and reduced to its immutable `sha256:<image-id>`;
- toolchain probes and behavior execution use that immutable materialized image ID, never a mutable tag.

The existing `pinned-reference` mode remains supported for externally available immutable registry artifacts. There is no fallback from `source-attested-build` to a tag, latest image, Compose service state, or host command.

## Qualification ownership

The standalone qualification fixture contains a source-attested behavior runner. R-3 builds it only after the consumer and exact harness gitlink are committed, then immediately proves materialization and image/source attestation. R-4 brings up the isolated Docker behavior gateway with the same Runtime workspace volume used by the worker and Context Engine.

The builder may use a mutable local tag only as a build output handle. The tag is not authority and is never used by Runtime execution.

## Security properties

This preserves the intended trust chain without circular identity:

```text
committed consumer source
        |
        v
source snapshot + runner spec + source binding
        |
        v
trusted post-commit image build
        |
        v
three authority labels
        |
        v
unique immutable image ID
        |
        v
toolchain + behavior execution under task fence
```

A stale source image, wrong runner image, wrong dependency/Compose binding, missing image, or ambiguous image set fails closed.

## Consequences

- Local source-attested images become constructible and independently reproducible per Docker daemon.
- The descriptor no longer needs to know the future image digest for this mode.
- Runtime still executes an immutable image ID.
- Registry portability remains available through `pinned-reference`; local qualification/rebuild workflows use `source-attested-build`.
- WAVE-10 runtime/fault qualification can now exercise a real source-attested behavior command rather than a fake precomputed image identity.
