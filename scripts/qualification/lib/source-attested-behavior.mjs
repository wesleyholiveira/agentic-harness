import { loadCommittedProjectConfiguration } from "../../../packages/project-adapters/src/trusted-config.mjs";
import { probeDockerRunnerMaterialization } from "../../../packages/project-adapters/src/docker-materialization-v2.mjs";
import { probeDockerImageSourceAttestation } from "../../../packages/project-adapters/src/docker-image-attestation.mjs";
import {
  dockerRunnerSourceBindingDigest,
  dockerRunnerSpecDigest,
} from "../../../packages/harness-contracts/src/docker-runner-v2.mjs";

function failure(code, evidence = {}) {
  const error = new Error(code);
  error.code = code;
  error.evidence = evidence;
  throw error;
}

export function qualificationBehaviorAuthority(consumerRoot, { runnerId = "qualification-behavior" } = {}) {
  const configuration = loadCommittedProjectConfiguration(consumerRoot);
  const spec = configuration.descriptor.runners.find(item => item.id === runnerId) ?? null;
  const sourceBinding = spec
    ? configuration.runnerSourceBindings.find(item => item.runnerId === spec.id) ?? null
    : null;
  if (!spec || !sourceBinding || spec.operation !== "one-off" || spec.image.mode !== "source-attested-build") {
    failure("qualification_behavior_runner_configuration_missing", {
      runnerId,
      operation: spec?.operation ?? null,
      imageMode: spec?.image?.mode ?? null,
    });
  }
  return {
    configuration,
    spec,
    sourceBinding,
    runnerSpecDigest: dockerRunnerSpecDigest(spec),
    sourceBindingDigest: dockerRunnerSourceBindingDigest(sourceBinding, { spec }),
  };
}

export function buildSourceAttestedQualificationImage({
  consumerRoot,
  run,
  runnerId = "qualification-behavior",
  labelPrefix = "qualification-behavior",
}) {
  if (typeof run !== "function") failure("qualification_behavior_runner_missing_process_runner");
  const authority = qualificationBehaviorAuthority(consumerRoot, { runnerId });
  const {
    configuration, spec, sourceBinding, runnerSpecDigest, sourceBindingDigest,
  } = authority;
  const imageTag = sourceBindingDigest.slice("sha256:".length, "sha256:".length + 20);
  const buildEnv = {
    AGENT_HARNESS_SOURCE_SNAPSHOT_SHA256: configuration.sourceSnapshotSha256,
    AGENT_HARNESS_RUNNER_SPEC_DIGEST: runnerSpecDigest,
    AGENT_HARNESS_SOURCE_BINDING_DIGEST: sourceBindingDigest,
    AGENT_HARNESS_QUALIFICATION_BEHAVIOR_TAG: imageTag,
  };
  const args = [
    "--context", spec.dockerContext,
    "compose",
    "--project-directory", consumerRoot,
    "-p", spec.composeProject,
    ...spec.composeFiles.flatMap(file => ["-f", file]),
    ...spec.profiles.flatMap(profile => ["--profile", profile]),
    "build",
    spec.service,
  ];
  run("docker", args, {
    cwd: consumerRoot,
    env: buildEnv,
    label: `${labelPrefix}-build`,
    timeoutMs: 15 * 60_000,
  });

  const materialized = probeDockerRunnerMaterialization(
    { spec, sourceBinding },
    { root: consumerRoot, timeoutMs: 60_000 },
  );
  if (materialized.status !== "MATERIALIZED") {
    failure("qualification_behavior_runner_materialization_failed", {
      code: materialized.code,
      runnerId: spec.id,
      calls: materialized.calls,
      probe: materialized.evidence ?? {},
    });
  }
  const attested = probeDockerImageSourceAttestation(
    { spec, sourceBinding, materialization: materialized.materialization },
    { root: consumerRoot, timeoutMs: 30_000 },
  );
  if (attested.status !== "ATTESTED") {
    failure("qualification_behavior_runner_attestation_failed", {
      code: attested.code,
      runnerId: spec.id,
      imageId: materialized.materialization.imageId,
    });
  }
  return {
    runnerId: spec.id,
    sourceCommit: configuration.sourceCommit,
    sourceSnapshotSha256: configuration.sourceSnapshotSha256,
    descriptorDigest: configuration.descriptorDigest,
    policyDigest: configuration.policyDigest,
    runnerSpecDigest,
    sourceBindingDigest,
    imageId: materialized.materialization.imageId,
    attestationIdentityDigest: attested.attestationIdentityDigest,
    imageTag,
    configuration,
  };
}
