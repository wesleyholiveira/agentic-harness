# Implementation wave 04 — immutable runner spec and committed source/policy trust

Authorization: continuation of the approved SDD/TDD implementation.
Branch: `fix/agent-start-current-user-message-authority-20260919`.
Baseline before this wave: WAVE-03 + Windows corrective slice.

## Goal

Remove the circular identity problem identified in WAVE-03 before activating command IDs in Technical Refinement/executor. A project descriptor must describe stable execution intent; source/image/daemon/mount hashes are observations produced later.

## Delivered slice

### DockerRunnerSpec/v2

`packages/harness-contracts/src/docker-runner-v2.mjs` introduces a declarative runner spec containing context/project/service, ordered Compose paths, profiles, operation/replica, container cwd/user/platform/build target, image selection policy and dependency file paths.

It deliberately excludes:
- sourceSnapshotSha256
- daemonId
- imageId
- configPublicSha256
- mountsSha256
- dependencyLockSha256

Exec runners derive image identity from the selected running service later. One-off runners require a registry reference pinned by sha256 and may not silently use a floating tag.

### Source binding and materialization

The same contract separates:
1. `DockerRunnerSourceBinding/v1`: immutable Git commit/source identity plus exact hashes for declared Compose/dependency files.
2. `DockerRunnerMaterialization/v1`: later live daemon/image/config/mount/container observation bound to the spec and source binding.

This removes the descriptor↔sourceSnapshot circular dependency. Materialization validation does not grant execution or qualification.

### ProjectDescriptor/v2 and ExecutionPolicy/v2

The v2 descriptor holds runner specs only and points to a committed policy path under `.agent-harness/`. Modules/commands cannot use `.agent-harness` as execution cwd/ownership.

ExecutionPolicy/v2 binds:
- descriptor digest
- exact CommandSpec digest
- runner spec digest
- scope/network/effects/timeout/secret permission

Structural evaluation remains non-authoritative until committed-source provenance is established.

### Committed source/policy loader

`loadCommittedProjectConfiguration` reads `.agent-harness/project.json` and its referenced policy **from Git blobs at one commit**, never from mutable worktree bytes. It computes source identity, validates descriptor/policy, creates source bindings for each runner, and returns explicit:
- sourceTrustVerified=true
- policyTrustVerified=true
- workingTreeChecked=false
- workspaceBindingVerified=false
- qualificationVerdict=null

A dirty worktree cannot rewrite committed configuration authority. Conversely, this is not permission to execute against an arbitrary dirty workspace; workspace binding remains a later gate.

Source identity adds `record-only` symlink policy: symlink bytes can participate in commit identity without authorizing dereference. Selected descriptor/policy/Compose/dependency inputs still must be regular Git files. Evidence readers continue to reject symlink traversal.

### Committed command admission

`admitCommittedCommand` upgrades a structurally covered command only to `SOURCE_POLICY_TRUSTED`. It remains:
- executableNow=false
- workspaceBindingVerified=false
- materializationVerified=false
- toolchainVerified=false
- behaviorAuthorized=false

This is the intended seam for the next T04 runtime integration.

## TDD

New file: `tests/contracts/trusted-project-config-v2.test.mjs`.

It covers stable declarative specs, pinned one-off image references, Git-blob config trust, worktree tamper resistance, non-circular source changes, compose/dependency binding, missing inputs, bad policy digest, protected config paths, untrusted structural evaluation, non-executable committed admission, restrictive grant HOLD, spec/source/materialization agreement and redacted CLI output.

The source-identity suite gains a record-only symlink identity case. The foundation Docker target includes the new suite.

These new WAVE-04 tests are not executed by this publication environment. Run them on the target host and Docker target before marking GREEN.

## Boundary

Not yet implemented:
- live DockerRunnerMaterialization production probe for v2;
- workspace commit/source binding inside Runtime task workspaces;
- active Technical Refinement schema using command IDs;
- behavior command executor/enforcement;
- secret resolution/network enforcement;
- T10 receipt trust and T13 public CLI integration.

No L1/L2/semantic cache/ProjectMemory/worker/model-routing/consumer pin/main changes are included.
