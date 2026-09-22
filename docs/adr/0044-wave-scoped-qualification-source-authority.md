# ADR 0044 — Wave-scoped qualification uses live Git source identity; release promotion requires MANIFEST

Status: Accepted

## Context

The standalone qualification has two different jobs:

1. prove runtime behavior while implementation waves are still changing tracked
   source; and
2. promote one final immutable harness release.

Those jobs share most gates but do not have the same source-closure artifact.

`MANIFEST.json` is the release certificate input. It enumerates the final
tracked source set and tree digest. Regenerating it during every implementation
wave creates a new source commit solely to make an intermediate qualification
candidate self-describe a tree that is expected to change again. It also makes
intermediate wave PASS evidence look like final release promotion evidence.

WAVE-10 reached this boundary on candidate
`3d7cfc5a9f89616fb620e2fa9e2e8916680576a9`. PRE-R0 proved the exact clean
HEAD, but full R-0 correctly rejected the stale release manifest: the tracked
tree contained 688 source files excluding MANIFEST while the existing manifest
contained 547.

The WAVE-10 physical-worker-loss gate still needs exact source identity, but it
must not mutate MANIFEST before T17.

## Decision

The default standalone scope remains `full-promotion`.

### full-promotion

- requires a clean Git worktree;
- requires exact HEAD stability;
- requires `source-manifest.mjs --check` to pass;
- is the only scope with `promotionEligible=true`;
- remains the T17 release authority.

### wave10-worker-loss

The standalone controller accepts the explicit internal flag:

`--wave10-worker-loss`

This scope:

- is always `promotionEligible=false`;
- requires a clean Git worktree and stable exact HEAD;
- computes the current source identity with
  `source-manifest.mjs` using `git-tracked-worktree` authority;
- requires no non-ignored untracked files;
- requires MANIFEST itself to remain tracked;
- records `R0_MANIFEST_STATUS=DEFERRED_T17`;
- does not run `source-manifest.mjs --check`;
- executes only the prerequisite gates for physical R-9 worker-loss:
  Q-ENTRY, PRE-R0, R-0, R-1, R-2, R-3, R-4, R-5, R-6 and R-9;
- deliberately excludes R-7, R-8 and R-10 because those semantic/continuation
  qualifications do not provide state consumed by R-9;
- still runs R-11 cleanup/source-equality.

The generated qualification report includes `qualificationScope` and
`promotionEligible`. Its Markdown verdict explicitly says
`NOT A RELEASE PROMOTION` for scoped qualification.

R-3 continues to pin the exact harness HEAD as the consumer gitlink and compare
the consumer submodule's live source tree digest against R-0. R-11 continues to
require the post-cleanup HEAD/tree/working-tree identity to equal the source
identity captured by scoped R-0.

## Consequences

Wave qualification can prove the exact current candidate without manufacturing
a MANIFEST-only commit.

A scoped PASS is valid evidence only for the named wave gate. It cannot move a
consumer qualified pin, release lock, certificate or promotion state.

T17 must regenerate MANIFEST after all source-changing work is complete, commit
that exact artifact, run `source-manifest.mjs --check`, and execute the full
promotion qualification on that final clean SHA.

The default command without the explicit scope remains fail-closed on a stale
MANIFEST.

## Rejected alternatives

### Regenerate MANIFEST before every wave qualification

Rejected because MANIFEST is final release closure authority, not an
implementation-wave heartbeat. This would continuously create new candidate
SHAs and blur wave evidence with release promotion.

### Silently ignore MANIFEST mismatch in R-0

Rejected because default standalone qualification must remain release-safe.
Only an explicit non-promotional scope may use live Git source authority.

### Skip R-0 entirely for WAVE-10

Rejected because R-0 owns additional source and ingress invariants beyond the
manifest comparison. Scoped qualification runs the same R-0 checks and changes
only the MANIFEST closure requirement.

### Re-run R-7/R-8/R-10 before every WAVE-10 R-9 attempt

Rejected because they do not establish state consumed by R-9 and would add
unrelated model/runtime cost. Their preservation remains part of later full
qualification.
