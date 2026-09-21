import { loadCommittedProjectConfiguration } from './trusted-config.mjs';

function projection(command) {
  return {
    id: command.id,
    moduleId: command.moduleId,
    runnerId: command.runnerId,
    phase: command.phase,
    executable: command.executable,
    argv: [...command.argv],
    cwd: command.cwd,
    validationScope: command.validationScope,
    networkPolicy: command.networkPolicy,
    effects: [...command.effects],
    requiredCapabilities: [...command.requiredCapabilities],
    envAllowlist: [...command.envAllowlist],
    secretRefCount: command.secretRefs.length,
    timeoutMs: command.timeoutMs,
    dependencyPolicy: command.dependencyPolicy,
    source: 'committed-project-descriptor',
  };
}

/**
 * Optional bridge for active Technical Refinement. Absence of project.json keeps
 * legacy projects on the existing validation-string path. A present but invalid
 * committed configuration fails closed and MUST NOT silently degrade to legacy.
 */
export function buildCommittedCommandSpecCatalog(workspace, { commit = 'HEAD' } = {}) {
  try {
    const configuration = loadCommittedProjectConfiguration(workspace, { commit });
    return {
      status: 'ok',
      sourceCommit: configuration.sourceCommit,
      sourceSnapshotSha256: configuration.sourceSnapshotSha256,
      descriptorDigest: configuration.descriptorDigest,
      policyDigest: configuration.policyDigest,
      catalog: configuration.descriptor.commands.map(projection),
      configuration,
    };
  } catch (error) {
    if (error?.code === 'source_selected_file_missing_or_not_regular'
        || error?.code === 'source_git_command_failed:rev-parse') {
      return {
        status: 'absent',
        sourceCommit: null,
        sourceSnapshotSha256: null,
        descriptorDigest: null,
        policyDigest: null,
        catalog: [],
        configuration: null,
      };
    }
    throw error;
  }
}
