import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateProjectDescriptor, projectDescriptorDigest, validateCommandSpec } from '../../packages/harness-contracts/src/project-descriptor.mjs';
import { discoverProject, loadProjectDescriptor } from '../../packages/project-adapters/src/discovery.mjs';
import { planDockerCommand } from '../../packages/project-adapters/src/planner.mjs';
import { probeDockerIdentity } from '../../packages/project-adapters/src/docker-probe.mjs';
import { checkedPath } from '../../packages/project-adapters/src/safe-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const H = 'sha256:' + 'a'.repeat(64);
const CID = 'c'.repeat(64);
function runner(overrides = {}) {
  return { schemaVersion: 'docker-runner-ref/v1', id: 'test-runner', kind: 'docker-compose', dockerContext: 'default', daemonId: 'daemon-a', composeProject: 'example', composeFiles: [{ path: 'compose.yaml', sha256: H }], profiles: ['test'], service: 'tests', purpose: 'test', operation: 'exec', replica: 1, containerCwd: '/workspace', user: '1000:1000', platform: 'linux/amd64', buildTarget: 'test', imageId: H, configPublicSha256: H, sourceSnapshotSha256: H, mountsSha256: H, dependencyLockSha256: H, ...overrides };
}
function command(overrides = {}) {
  return { schemaVersion: 'command-spec/v1', id: 'unit', moduleId: 'api', runnerId: 'test-runner', phase: 'behavior', executable: 'python', argv: ['-m', 'pytest', '-q'], cwd: 'services/api', envAllowlist: [], secretRefs: [], requiredCapabilities: ['language.python'], networkPolicy: 'none', effects: ['workspace-write'], timeoutMs: 60000, dependencyPolicy: 'required', validationScope: 'workspace', ...overrides };
}
function descriptor() {
  return { schemaVersion: 'project-descriptor/v1', projectId: 'project-a', repositoryId: 'repository-a', policyRef: 'policy/engineering-v1', modules: [{ id: 'api', root: 'services/api', languages: ['python'], requiredCapabilities: ['language.python'] }], evidenceRoots: ['docs'], protectedPaths: ['.harness', '.env'], runners: [runner()], commands: [command()] };
}
function fixture(t, files = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'descriptor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(resolve(dir, p)), { recursive: true }); writeFileSync(resolve(dir, p), text); }
  return dir;
}
function discover(root, moduleRoots = ['.']) { return discoverProject(root, { projectId: 'project-a', repositoryId: 'repository-a', moduleRoots }); }

test('descriptor and commands are validated without mutation or inferred authorization', () => {
  const d = descriptor(), before = structuredClone(d);
  assert.deepEqual(validateProjectDescriptor(d), d);
  const copy = validateProjectDescriptor(d); copy.modules[0].languages.push('go');
  assert.deepEqual(d, before);
  assert.deepEqual(validateCommandSpec(command()), command());
});
for (const [name, change] of [
  ['unknown field', d => { d.approved = true; }],
  ['unknown version', d => { d.schemaVersion = 'project-descriptor/v99'; }],
  ['project identity absent', d => { delete d.projectId; }],
  ['repository identity absent', d => { delete d.repositoryId; }],
  ['duplicate modules', d => { d.modules.push(structuredClone(d.modules[0])); }],
  ['case-colliding roots', d => { d.modules.push({ ...d.modules[0], id: 'other', root: 'SERVICES/API' }); }],
  ['unknown module', d => { d.commands[0].moduleId = 'missing'; }],
  ['unknown runner', d => { d.commands[0].runnerId = 'missing'; }],
  ['cwd outside module', d => { d.commands[0].cwd = 'other'; }],
  ['cwd escape', d => { d.commands[0].cwd = 'services/api/../../other'; }],
  ['protected module', d => { d.protectedPaths.push('services'); }],
  ['unqualified host fallback', d => { d.runners[0].kind = 'host'; }],
  ['duplicate commands', d => { d.commands.push(command()); }],
  ['unresolved image tag', d => { d.runners[0].imageId = 'python:latest'; }],
  ['invalid environment key', d => { d.commands[0].envAllowlist = ['X=secret']; }],
  ['inline secrets object', d => { d.commands[0].secrets = { token: 'secret-value' }; }],
  ['unsupported shell', d => { d.commands[0].executable = 'bash'; }],
  ['flag executable', d => { d.commands[0].executable = '--privileged'; }],
  ['nul argument', d => { d.commands[0].argv = ['x\0y']; }],
  ['invalid timeout', d => { d.commands[0].timeoutMs = Infinity; }],
  ['unsafe env injection', d => { d.commands[0].envAllowlist = ['NODE_OPTIONS']; }],
  ['unknown network policy', d => { d.commands[0].networkPolicy = 'whatever'; }],
]) test(`rejects ${name}`, () => { const d = descriptor(); change(d); assert.throws(() => validateProjectDescriptor(d)); });

test('digest is stable across object-key insertion order but scoped by identity, policy and runner inputs', () => {
  const d = descriptor();
  const reordered = Object.fromEntries(Object.entries(d).reverse());
  assert.equal(projectDescriptorDigest(d), projectDescriptorDigest(reordered));
  for (const change of [x => x.projectId = 'project-b', x => x.repositoryId = 'repository-b', x => x.policyRef = 'policy/other', x => x.runners[0].imageId = 'sha256:' + 'b'.repeat(64), x => x.runners[0].profiles.reverse().push('extra')]) {
    const other = structuredClone(d); change(other);
    assert.notEqual(projectDescriptorDigest(d), projectDescriptorDigest(other));
  }
});

test('discovery reads markers without requiring host tools or inventing npm for Python', t => {
  const dir = fixture(t, { 'pyproject.toml': '[project]\nname="api"\n', 'README.md': '# api' });
  const report = discover(dir);
  assert.deepEqual(report.modules[0].languages, ['python']);
  assert.deepEqual(report.modules[0].commandSuggestions, []);
  assert.equal(report.authorization, 'none'); assert.equal(report.remoteCalls, 0); assert.equal(report.processesSpawned, 0);
});
for (const [marker, language] of [['Cargo.toml', 'rust'], ['go.mod', 'go'], ['pom.xml', 'java'], ['build.gradle.kts', 'java'], ['sample.csproj', 'dotnet'], ['README.md', 'docs']]) {
  test(`recognizes ${marker} without executing build code`, t => {
    const dir = fixture(t, { [marker]: '# inert marker\n' });
    assert.deepEqual(discover(dir).modules[0].languages, [language]);
  });
}
test('explicit module discovery handles mixed package managers without executing scripts', t => {
  const dir = fixture(t, {
    'frontend/package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { test: 'DO_NOT_EXECUTE_SECRET', build: 'another', start: 'no' } }),
    'backend/package.json': JSON.stringify({ packageManager: 'bun@1.0', scripts: { 'test:unit': 'NOT_EXECUTED' } }),
  });
  const report = discover(dir, ['frontend', 'backend']);
  const front = report.modules.find(m => m.root === 'frontend');
  const back = report.modules.find(m => m.root === 'backend');
  assert.equal(front.packageManager, 'pnpm'); assert.equal(back.packageManager, 'bun');
  assert.ok(front.commandSuggestions.every(c => c.executable === 'pnpm' && c.authorization === 'none'));
  assert.ok(!JSON.stringify(report).includes('DO_NOT_EXECUTE_SECRET'));
  assert.equal(report.processesSpawned, 0);
});
test('conflicting manager locks do not silently select npm', t => {
  const dir = fixture(t, { 'package.json': '{"scripts":{"test":"bad"}}', 'yarn.lock': '', 'package-lock.json': '{}' });
  const m = discover(dir).modules[0];
  assert.equal(m.packageManager, null); assert.deepEqual(m.commandSuggestions, []);
  assert.ok(m.warnings.includes('package_manager_ambiguous'));
});
test('an explicit manager contradicting a lock is unresolved rather than guessed', t => {
  const dir = fixture(t, { 'package.json': '{"packageManager":"pnpm@9","scripts":{"test":"bad"}}', 'package-lock.json': '{}' });
  assert.equal(discover(dir).modules[0].packageManager, null);
});
test('unknown package manager remains unresolved', t => {
  const dir = fixture(t, { 'package.json': '{"packageManager":"custom@1","scripts":{"test":"bad"}}' });
  assert.equal(discover(dir).modules[0].packageManager, null);
});
test('project identities are explicit; moving a project does not infer a new one from basename', t => {
  const a = fixture(t, { 'go.mod': 'module example' }), b = fixture(t, { 'go.mod': 'module example' });
  assert.deepEqual(discover(a), discover(b));
  assert.throws(() => discoverProject(a, { moduleRoots: ['.'] }), /project_identity_invalid/);
});
for (const p of ['../outside', '.harness', '.runtime/agents', 'node_modules/pkg', '.git', '.env']) test(`discovery rejects unsafe/private module ${p}`, t => {
  const dir = fixture(t); assert.throws(() => discover(dir, [p]));
});
test('discovery never reads env values or emits source body', t => {
  const dir = fixture(t, { '.env': 'TOKEN=PRIVATE', 'pyproject.toml': 'token="hidden"', 'compose.yaml': 'password: secret\n' });
  const report = discover(dir);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  assert.ok(!JSON.stringify(report).includes('hidden'));
  assert.ok(!JSON.stringify(report).includes('password'));
  assert.ok(report.modules[0].evidence.every(e => e.sha256.startsWith('sha256:')));
});
test('symlinked marker policy is exercised without requiring Windows symlink privilege', t => {
  const dir = fixture(t, { 'package.json': '{}' });
  const marker = resolve(dir, 'package.json');
  assert.throws(() => checkedPath(dir, 'package.json', {
    lstat: path => path === marker
      ? { isSymbolicLink: () => true, isDirectory: () => false }
      : lstatSync(path),
  }), /project_path_symlink/);
});
test('symlinked ancestor policy is exercised without requiring Windows symlink privilege', t => {
  const dir = fixture(t, { 'alias/Cargo.toml': '' });
  const alias = resolve(dir, 'alias');
  assert.throws(() => checkedPath(dir, 'alias/Cargo.toml', {
    lstat: path => path === alias
      ? { isSymbolicLink: () => true, isDirectory: () => true }
      : lstatSync(path),
  }), /project_path_symlink/);
});
test('metadata quota and invalid JSON fail with redacted typed error', t => {
  const dir = fixture(t, { 'package.json': 'PRIVATE_NOT_JSON' });
  assert.throws(() => discover(dir), err => err.code === 'project_json_invalid' && !err.message.includes('PRIVATE'));
  writeFileSync(resolve(dir, 'package.json'), ' '.repeat(262145));
  assert.throws(() => discover(dir), /project_file_limit/);
});
test('duplicate JSON keys, including escaped names, are not silently overwritten', t => {
  const dir = fixture(t, { 'package.json': '{"scripts":{},"scr\\u0069pts":{"test":"bad"}}' });
  assert.throws(() => discover(dir), /project_json_duplicate_key/);
});
test('loader validates descriptor and returns identity without activating policy', t => {
  const d = descriptor(), dir = fixture(t, { '.agent-harness/project.json': JSON.stringify(d) });
  const loaded = loadProjectDescriptor(dir);
  assert.deepEqual(loaded.descriptor, d); assert.equal(loaded.digest, projectDescriptorDigest(d));
  assert.equal(loaded.authorization, 'none'); assert.equal(loaded.qualificationVerdict, null);
});

test('Docker command plan targets declared context/service/replica/cwd; not host python', () => {
  const p = planDockerCommand(descriptor(), 'unit');
  assert.equal(p.invocation.executable, 'docker'); assert.equal(p.invocation.shell, false);
  assert.deepEqual(p.invocation.argv, ['--context','default','compose','--project-directory','.','-p','example','-f','compose.yaml','--profile','test','exec','-T','--interactive=false','--index','1','--user','1000:1000','--workdir','/workspace/services/api','tests','python','-m','pytest','-q']);
  assert.equal(p.authorization, 'pending'); assert.equal(p.executableNow, false); assert.equal(p.qualificationVerdict, null);
  assert.ok(p.requiredGates.includes('trusted-policy')); assert.ok(p.requiredGates.includes('toolchain-evidence'));
});
test('one-off is explicit, never pulls/builds/prunes, and only no-deps when declared none', () => {
  const d = descriptor(); d.runners[0] = runner({ operation: 'one-off', replica: null });
  let p = planDockerCommand(d, 'unit');
  assert.ok(p.invocation.argv.includes('run')); assert.ok(!p.invocation.argv.includes('--no-deps'));
  assert.ok(!p.invocation.argv.includes('--build')); assert.deepEqual(p.invocation.argv.slice(p.invocation.argv.indexOf('--pull'), p.invocation.argv.indexOf('--pull') + 2), ['--pull','never']);
  d.commands[0].dependencyPolicy = 'none'; p = planDockerCommand(d, 'unit'); assert.ok(p.invocation.argv.includes('--no-deps'));
  assert.ok(p.requiredGates.includes('entrypoint-validation'));
});
test('argv preserves quotes/metacharacters as data rather than a concatenated shell', () => {
  const d = descriptor(); d.commands[0].argv = ['-k', 'a; echo pwned', '$TOKEN', 'name with spaces'];
  assert.deepEqual(planDockerCommand(d, 'unit').invocation.argv.slice(-4), d.commands[0].argv);
});
test('command plan binds runner and descriptor identity, rejects unknown command and has no implicit host fallback', () => {
  const d = descriptor(), p = planDockerCommand(d, 'unit');
  assert.equal(p.descriptorDigest, projectDescriptorDigest(d)); assert.equal(p.runnerId, 'test-runner');
  assert.throws(() => planDockerCommand(d, 'missing'), /project_command_unknown/);
  d.runners[0].imageId = 'sha256:' + 'b'.repeat(64); assert.notEqual(planDockerCommand(d, 'unit').planDigest, p.planDigest);
});

function fakeDocker({ daemon = 'daemon-a', image = H, candidates = [CID], running = true, replica = '1', restarted = false, commandFailure = null } = {}) {
  let inspected = 0; const calls = [];
  const execute = argv => {
    calls.push(argv);
    if (commandFailure) return { status: 1, stdout: 'PRIVATE', stderr: 'PRIVATE', error: commandFailure };
    if (argv.includes('info')) return { status: 0, stdout: JSON.stringify(daemon) };
    if (argv[2] === 'image') return { status: 0, stdout: JSON.stringify({ id: image, os: 'linux', architecture: 'amd64' }) };
    if (argv.includes('ps')) return { status: 0, stdout: candidates.join('\n') };
    inspected++;
    return { status: 0, stdout: JSON.stringify({ id: argv.at(-1), image: H, running, restartCount: restarted && inspected > candidates.length ? 1 : 0, startedAt: restarted && inspected > candidates.length ? '2026-09-20T11:00:00Z' : '2026-09-20T10:00:00Z', project: 'example', service: 'tests', replica, oneoff: 'False' }) };
  };
  return { calls, execute };
}
test('read-only Docker identity probe is partial, never toolchain/behavior PASS', () => {
  const fake = fakeDocker(), p = probeDockerIdentity(runner(), { execute: fake.execute });
  assert.equal(p.status, 'PARTIAL'); assert.equal(p.containerId, CID); assert.equal(p.imageId, H);
  assert.equal(p.toolchain, 'NOT_RUN'); assert.equal(p.behavior, 'NOT_RUN'); assert.equal(p.trustVerified, false);
  assert.equal(p.qualificationVerdict, null); assert.ok(fake.calls.every(c => !c.includes('exec') && !c.includes('run') && !c.includes('up') && !c.includes('pull')));
});
for (const [name, opts, code] of [
  ['daemon mismatch', { daemon: 'other' }, 'docker_daemon_mismatch'],
  ['image mismatch', { image: 'sha256:'+'b'.repeat(64) }, 'docker_image_mismatch'],
  ['no container', { candidates: [] }, 'docker_container_missing'],
  ['wrong replica', { replica: '2' }, 'docker_container_missing'],
  ['stopped', { running: false }, 'docker_container_missing'],
  ['ambiguity', { candidates: [CID, 'd'.repeat(64)] }, 'docker_container_ambiguous'],
  ['restart', { restarted: true }, 'docker_container_changed'],
]) test(`Docker probe HOLD for ${name}`, () => {
  const fake = fakeDocker(opts), p = probeDockerIdentity(runner(), { execute: fake.execute });
  assert.equal(p.status, 'HOLD'); assert.equal(p.code, code); assert.equal(p.qualificationVerdict, null);
});
test('Docker unavailable returns HOLD with no host fallback or raw stderr leak', () => {
  const fake = fakeDocker({ commandFailure: { code: 'ENOENT' } });
  const p = probeDockerIdentity(runner(), { execute: fake.execute });
  assert.equal(p.status, 'HOLD'); assert.equal(p.code, 'docker_command_unavailable');
  assert.ok(!JSON.stringify(p).includes('PRIVATE')); assert.equal(fake.calls.length, 1);
});
test('one-off identity probe observes only daemon/image and does not create a container', () => {
  const fake = fakeDocker(); const p = probeDockerIdentity(runner({ operation: 'one-off', replica: null }), { execute: fake.execute });
  assert.equal(p.status, 'PARTIAL'); assert.equal(p.containerId, null); assert.equal(fake.calls.length, 2);
});
test('CLI discovery is read-only and CLI plan does not emit argv or spawn docker without explicit probe', t => {
  const d = descriptor(), dir = fixture(t, { '.agent-harness/project.json': JSON.stringify(d) });
  const cli = resolve(ROOT, 'packages/project-adapters/bin/inspect.mjs');
  const result = spawnSync(process.execPath, [cli, '--root', dir, '--command', 'unit'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout); assert.equal(json.authorization, 'pending'); assert.equal(json.executableNow, false);
  assert.equal(json.invocation, undefined); assert.equal(json.dockerProbe, undefined);
  assert.equal(readFileSync(resolve(dir, '.agent-harness/project.json'), 'utf8'), JSON.stringify(d));
});
test('CLI rejects unknown flags rather than falling back to a different action', t => {
  const dir = fixture(t); const result = spawnSync(process.execPath, [resolve(ROOT, 'packages/project-adapters/bin/inspect.mjs'), '--root', dir, '--execute'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.ok(!result.stderr.includes('PRIVATE'));
});

test('Docker probe resolves Compose relative to explicit project root, not controller cwd', t => {
  const dir = fixture(t, { 'compose.yaml': 'services: {}' }), fake = fakeDocker(); const observed = [];
  const result = probeDockerIdentity(runner(), { root: dir, execute: (argv, options) => { observed.push(options.cwd); return fake.execute(argv); } });
  assert.equal(result.status, 'PARTIAL'); assert.ok(observed.length > 0); assert.ok(observed.every(cwd => cwd === dir));
});
test('JSON null in package metadata fails instead of being treated as no metadata', t => {
  const dir = fixture(t, { 'package.json': 'null' });
  assert.throws(() => discover(dir), /project_package_shape_invalid/);
});
test('descriptor disallows nested reserved roots consistently with discovery', () => {
  for (const root of ['services/.harness', 'services/node_modules/tool', '.env.private']) {
    const d = descriptor(); d.modules[0].root = root; d.commands[0].cwd = root;
    assert.throws(() => validateProjectDescriptor(d), /project_module_protected/);
  }
});
test('Docker identity collection checks Compose service mapping again after instance observation', () => {
  const fake = fakeDocker(); let psCalls = 0;
  const result = probeDockerIdentity(runner(), { execute: argv => {
    if (argv.includes('ps') && ++psCalls > 1) return { status: 0, stdout: 'd'.repeat(64) };
    return fake.execute(argv);
  } });
  assert.equal(result.status, 'HOLD'); assert.equal(result.code, 'docker_container_changed');
});
test('toolchain declaration still needs policy and actual container probe before executable admission', () => {
  const d = descriptor(); d.commands[0] = command({ phase: 'toolchain', argv: ['--version'], effects: ['read-only'] });
  const p = planDockerCommand(d, 'unit');
  assert.ok(p.requiredGates.includes('trusted-policy')); assert.ok(!p.requiredGates.includes('toolchain-evidence'));
  assert.equal(p.executableNow, false);
});
test('ordered Compose overlays affect plan identity and never select a service by substring', () => {
  const d = descriptor(); d.runners[0].composeFiles.push({ path: 'compose.test.yaml', sha256: H });
  const a = planDockerCommand(d, 'unit'); d.runners[0].composeFiles.reverse();
  assert.notEqual(planDockerCommand(d, 'unit').planDigest, a.planDigest);
});
test('Docker timeout and malformed output stay HOLD without printing tool output', () => {
  for (const result of [{ status: null, error: { code: 'ETIMEDOUT' }, stdout: 'SECRET' }, { status: 0, stdout: 'SECRET_NON_JSON' }]) {
    const p = probeDockerIdentity(runner(), { execute: () => result });
    assert.equal(p.status, 'HOLD'); assert.ok(!JSON.stringify(p).includes('SECRET'));
  }
});
test('descriptor path policy rejects a symlinked .agent-harness ancestor without OS privilege', t => {
  const dir = fixture(t, { '.agent-harness/project.json': JSON.stringify(descriptor()) });
  const harnessDir = resolve(dir, '.agent-harness');
  assert.throws(() => checkedPath(dir, '.agent-harness/project.json', {
    lstat: path => path === harnessDir
      ? { isSymbolicLink: () => true, isDirectory: () => true }
      : lstatSync(path),
  }), /project_path_symlink/);
});
test('JSON strings with braces or commas do not confuse duplicate-field detection', t => {
  const dir = fixture(t, { 'package.json': JSON.stringify({ description: 'x \\" } , {', scripts: { test: 'hello, {world}' }, nested: [{ x: 1 }, { x: 2 }] }) });
  assert.equal(discover(dir).modules[0].packageManager, 'npm');
});
test('invalid UTF-8 and excessive nesting fail before becoming a descriptor', t => {
  const dir = fixture(t, { 'package.json': Buffer.from([0xff]) }); assert.throws(() => discover(dir), /project_json_invalid/);
  writeFileSync(resolve(dir, 'package.json'), '['.repeat(65) + '0' + ']'.repeat(65));
  assert.throws(() => discover(dir), /project_json_depth_limit/);
});

test('native CLI discovery succeeds with all host product toolchains absent from PATH', t => {
  const dir = fixture(t, { 'pyproject.toml': '[project]\nname="api"\n' });
  const result = spawnSync(process.execPath, [resolve(ROOT, 'packages/project-adapters/bin/inspect.mjs'), '--root', dir, '--project-id', 'p', '--repository-id', 'r'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.processesSpawned, 0); assert.deepEqual(report.modules[0].languages, ['python']);
});
test('native CLI Docker identity unavailable is HOLD, not fallback to host toolchain', t => {
  const dir = fixture(t, { '.agent-harness/project.json': JSON.stringify(descriptor()) });
  const result = spawnSync(process.execPath, [resolve(ROOT, 'packages/project-adapters/bin/inspect.mjs'), '--root', dir, '--command', 'unit', '--docker-identity'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.dockerProbe.code, 'docker_command_unavailable');
  assert.equal(report.dockerProbe.calls, 1); assert.equal(report.executableNow, false); assert.equal(report.dockerProbe.toolchain, 'NOT_RUN');
});

test('identity probe does not evaluate Compose files or interpolate private env files', () => {
  const fake = fakeDocker(); probeDockerIdentity(runner(), { execute: fake.execute });
  assert.ok(!fake.calls.some(argv => argv.includes('compose')));
  const ps = fake.calls.find(argv => argv.includes('ps'));
  assert.ok(ps.includes('label=com.docker.compose.project=example'));
  assert.ok(ps.includes('label=com.docker.compose.service=tests'));
});
