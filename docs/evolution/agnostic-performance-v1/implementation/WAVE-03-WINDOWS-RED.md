# WAVE-03 target-host RED — Windows portability corrections

Source of evidence: operator-provided Windows harness log, 2026-09-20.
Source branch under test: `fix/agent-start-current-user-message-authority-20260919`.

## Observed failures

1. The command-grant test expected `descriptor-digest-mismatch` after deliberately forging only the grant's command digest. The implementation correctly reports the narrower `command-digest-mismatch`; the test oracle was wrong.
2. Java probe rejected a normal OpenJDK banner containing text/date after the quoted version on the first line. Parser was too restrictive.
3. Three tests attempted to create NTFS symlinks and failed with EPERM before reaching harness code on Windows without symlink privilege. The policy remains tested, but now through a deterministic lstat seam rather than skip/privilege dependence.
4. Source identity tests all failed before their intended assertions with `source_git_root_mismatch`. Git/Node can expose the same Windows directory through different textual spellings/casing/short-path forms. Root equality now checks physical directory identity first, with canonical case-insensitive path fallback on Windows.

## Corrections

- `tests/contracts/command-admission-v2.test.mjs`: correct command-digest reason.
- `packages/project-adapters/src/docker-toolchain.mjs`: accept standard first-line Java suffix text while still parsing only the quoted version.
- `packages/project-adapters/src/safe-files.mjs`: injectable lstat seam for deterministic path-policy tests; production default unchanged.
- `tests/contracts/project-descriptor.test.mjs`: symlink policy tests no longer require OS privilege and are not skipped.
- `packages/source-identity/src/git-snapshot.mjs`: compare the physical filesystem identity of Git toplevel and requested root; Windows fallback canonicalizes extended prefix, separators and case.

## Evidence status

The original operator log is RED evidence. The corrections were published after diagnosis. A clean target-host rerun is REQUIRED; this document does not mark GREEN. The publication environment could not clone GitHub to execute the branch because DNS/network access was unavailable. Docker-target, aggregate harness tests, Windows GREEN and Runtime qualification remain NOT_RUN after these fixes.

No cache/memory/worker/model-routing/consumer pin/main changes are part of this corrective slice. MANIFEST regeneration remains deferred to source freeze.
