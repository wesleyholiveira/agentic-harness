import { posix } from 'node:path';
import { fail } from '../../harness-contracts/src/source-identity.mjs';
import { validateProjectDescriptor, projectDescriptorDigest, contractDigest } from '../../harness-contracts/src/project-descriptor.mjs';
import { dockerRunnerDigest, validateDockerRunnerRef } from '../../harness-contracts/src/docker-runner.mjs';

/** Arguments only. Caller must use a native launcher from the project root. */
export function composePrefix(runner) {
  validateDockerRunnerRef(runner);
  return ['--context', runner.dockerContext, 'compose', '--project-directory', '.', '-p', runner.composeProject,
    ...runner.composeFiles.flatMap(f => ['-f', f.path]), ...runner.profiles.flatMap(p => ['--profile', p])];
}

/** This function deliberately never executes or grants an execution capability. */
export function planDockerCommand(input, commandId) {
  const descriptor = validateProjectDescriptor(input);
  const command = descriptor.commands.find(c => c.id === commandId);
  if (!command) fail('project_command_unknown');
  const runner = descriptor.runners.find(r => r.id === command.runnerId);
  const module = descriptor.modules.find(m => m.id === command.moduleId);
  const cwd = posix.join(runner.containerCwd, command.cwd);
  const operation = runner.operation === 'exec'
    ? ['exec','-T','--interactive=false','--index',String(runner.replica)]
    : ['run','--rm','-T','--interactive=false','--pull','never', ...(command.dependencyPolicy === 'none' ? ['--no-deps'] : [])];
  const invocation = { executable: 'docker', argv: [...composePrefix(runner), ...operation, '--user',runner.user,'--workdir',cwd,runner.service,command.executable,...command.argv], cwd: '.', shell: false };
  const identity = { descriptorDigest: projectDescriptorDigest(descriptor), runnerDigest: dockerRunnerDigest(runner), commandId: command.id, invocation };
  return { schemaVersion: 'docker-command-plan/v1', ...identity, planDigest: contractDigest(identity), projectId: descriptor.projectId, moduleId: module.id, runnerId: runner.id, phase: command.phase,
    requiredCapabilities: [...new Set([...module.requiredCapabilities, ...command.requiredCapabilities])].sort(),
    requiredGates: ['trusted-policy','current-source','current-compose-config','current-daemon-image-mounts','authorized-workspace','network-effects-enforcement','environment-secret-resolution', ...(runner.operation === 'one-off' ? ['entrypoint-validation'] : ['exact-container-instance']), ...(command.phase === 'behavior' ? ['toolchain-evidence'] : [])],
    authorization: 'pending', executableNow: false, qualificationVerdict: null };
}
