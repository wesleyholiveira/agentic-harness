#!/usr/bin/env node
import { discoverProject, loadProjectDescriptor } from '../src/discovery.mjs';
import { planDockerCommand } from '../src/planner.mjs';
import { probeDockerIdentity } from '../src/docker-probe.mjs';
import { probeDockerImageToolchain } from '../src/docker-toolchain.mjs';

try {
  const args = process.argv.slice(2), options = { modules: [] }, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--root','--project-id','--repository-id','--module','--command','--docker-identity','--toolchain'].includes(flag)
        || (flag !== '--module' && seen.has(flag))) throw new Error('project_cli_argument_invalid');
    seen.add(flag);
    if (flag === '--docker-identity') { options.probe = true; continue; }
    if (flag === '--toolchain') { options.toolchain = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('project_cli_argument_invalid');
    if (flag === '--module') options.modules.push(value); else options[flag.slice(2)] = value;
  }
  if (!options.root) throw new Error('project_cli_root_required');
  let report;
  if (options.command) {
    if (options['project-id'] || options['repository-id'] || options.modules.length) throw new Error('project_cli_mode_conflict');
    if (options.toolchain && !options.probe) throw new Error('project_cli_toolchain_requires_identity');
    const { descriptor } = loadProjectDescriptor(options.root);
    // CLI output deliberately omits potentially sensitive command/argv data.
    const { invocation: _invocation, ...plan } = planDockerCommand(descriptor, options.command);
    report = plan;
    if (options.probe) {
      const runner = descriptor.runners.find(r => r.id === plan.runnerId);
      report.dockerProbe = probeDockerIdentity(runner, { root: options.root });
      if (report.dockerProbe.status === 'HOLD') process.exitCode = 2;
      if (options.toolchain && report.dockerProbe.status !== 'HOLD') {
        report.toolchainProbe = probeDockerImageToolchain({ descriptor, commandId: options.command, identityObservation: report.dockerProbe }, { root: options.root });
        if (report.toolchainProbe.status !== 'TOOLCHAIN_VERIFIED') process.exitCode = 2;
      }
    }
  } else {
    if (options.probe || options.toolchain) throw new Error('project_cli_command_required');
    report = discoverProject(options.root, { projectId: options['project-id'], repositoryId: options['repository-id'], moduleRoots: options.modules.length ? options.modules : ['.'] });
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const candidate = error?.code ?? error?.message;
  const code = typeof candidate === 'string' && /^project_[a-z_]+$/u.test(candidate) ? candidate : 'project_inspection_failed';
  console.error(JSON.stringify({ status: 'HOLD', code, authorization: 'none', qualificationVerdict: null }));
  process.exitCode = 2;
}
