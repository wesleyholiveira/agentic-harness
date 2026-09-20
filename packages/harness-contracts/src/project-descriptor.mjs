/** Pure structural contracts. A valid declaration NEVER authorizes execution. */
import { createHash } from 'node:crypto';
import { assertKeys, assertRepositoryPath, fail } from './source-identity.mjs';
import { validateDockerRunnerRef } from './docker-runner.mjs';

export const PROJECT_DESCRIPTOR_VERSION = 'project-descriptor/v1';
export const COMMAND_SPEC_VERSION = 'command-spec/v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const FORBIDDEN_ENV = /^(?:LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|BASH_ENV|ENV|SHELLOPTS|COMPOSE_.*|DOCKER_.*)$/u;
const SHELLS = new Set(['sh','bash','zsh','fish','dash','cmd','cmd.exe','powershell','powershell.exe','pwsh','env','sudo','su']);
const COMMAND_FIELDS = ['schemaVersion','id','moduleId','runnerId','phase','executable','argv','cwd','envAllowlist','secretRefs','requiredCapabilities','networkPolicy','effects','timeoutMs','dependencyPolicy','validationScope'];

export function assertProjectId(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail('project_identity_invalid');
  return value;
}
export function assertProjectPath(value, { root = false } = {}) {
  if (root && value === '.') return value;
  try { return assertRepositoryPath(value); } catch { fail('project_path_invalid'); }
}
function list(value, validate, { min = 0, max = 128 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('project_array_invalid');
  for (const item of value) validate(item);
  if (new Set(value).size !== value.length) fail('project_array_duplicate');
}
function text(value, max = 8192) {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value) > max) fail('project_text_invalid');
}
function reference(value) { text(value, 256); if (!value || !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/u.test(value) || value.includes('..')) fail('project_reference_invalid'); }
function within(path, parent) { return parent === '.' || path === parent || path.startsWith(`${parent}/`); }
function fold(path) { return path.normalize('NFC').toLowerCase(); }
function reserved(path) { return fold(path).split('/').some(p => ['.git','.harness','.runtime','node_modules'].includes(p) || p.startsWith('.env')); }
function uniqueIds(items) {
  const ids = items.map(item => item.id);
  if (new Set(ids).size !== ids.length) fail('project_id_duplicate');
}

export function validateCommandSpec(command) {
  assertKeys(command, COMMAND_FIELDS, [], 'project_command_shape_invalid');
  if (command.schemaVersion !== COMMAND_SPEC_VERSION) fail('project_command_version_unsupported');
  for (const key of ['id','moduleId','runnerId']) assertProjectId(command[key]);
  if (!['toolchain','behavior'].includes(command.phase)) fail('project_command_phase_invalid');
  text(command.executable, 256);
  if (!command.executable || command.executable.startsWith('-') || /[\s\\]/u.test(command.executable)) fail('project_executable_invalid');
  const executablePath = command.executable.replace(/^\//u, '').replace(/^\.\//u, '');
  assertProjectPath(executablePath);
  if (SHELLS.has(executablePath.split('/').at(-1).toLowerCase())) fail('project_shell_not_supported');
  if (!Array.isArray(command.argv) || command.argv.length > 1024) fail('project_argv_invalid');
  command.argv.forEach(arg => text(arg));
  if (Buffer.byteLength(JSON.stringify(command.argv)) > 65536) fail('project_argv_limit');
  assertProjectPath(command.cwd, { root: true });
  list(command.envAllowlist, key => { if (typeof key !== 'string' || !ENV.test(key) || FORBIDDEN_ENV.test(key)) fail('project_environment_invalid'); });
  list(command.secretRefs, reference, { max: 32 });
  list(command.requiredCapabilities, assertProjectId);
  if (!['none','service-only','declared-external'].includes(command.networkPolicy)) fail('project_network_policy_invalid');
  list(command.effects, effect => { if (!['read-only','workspace-write','external-write'].includes(effect)) fail('project_effect_invalid'); }, { min: 1, max: 3 });
  if (command.effects.includes('read-only') && command.effects.length !== 1) fail('project_effect_conflict');
  if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 3600000) fail('project_timeout_invalid');
  if (!['required','none'].includes(command.dependencyPolicy)) fail('project_dependency_policy_invalid');
  if (!['workspace','container','authoritative-host','live'].includes(command.validationScope)) fail('project_validation_scope_invalid');
  return structuredClone(command);
}

export function validateProjectDescriptor(descriptor) {
  assertKeys(descriptor, ['schemaVersion','projectId','repositoryId','policyRef','modules','evidenceRoots','protectedPaths','runners','commands'], [], 'project_descriptor_shape_invalid');
  if (descriptor.schemaVersion !== PROJECT_DESCRIPTOR_VERSION) fail('project_descriptor_version_unsupported');
  assertProjectId(descriptor.projectId); assertProjectId(descriptor.repositoryId); reference(descriptor.policyRef);
  list(descriptor.modules, module => {
    assertKeys(module, ['id','root','languages','requiredCapabilities'], [], 'project_module_shape_invalid');
    assertProjectId(module.id); assertProjectPath(module.root, { root: true });
    list(module.languages, language => { if (typeof language !== 'string' || !/^[a-z][a-z0-9+.-]{0,63}$/u.test(language)) fail('project_language_invalid'); }, { min: 1 });
    list(module.requiredCapabilities, assertProjectId);
  }, { min: 1 });
  uniqueIds(descriptor.modules);
  if (new Set(descriptor.modules.map(m => fold(m.root))).size !== descriptor.modules.length) fail('project_module_root_duplicate');
  list(descriptor.evidenceRoots, p => assertProjectPath(p, { root: true }));
  list(descriptor.protectedPaths, p => assertProjectPath(p));
  const protectedPaths = ['.git','.harness','.runtime','node_modules', ...descriptor.protectedPaths].map(fold);
  for (const module of descriptor.modules) {
    if (reserved(module.root) || protectedPaths.some(p => within(fold(module.root), p))) fail('project_module_protected');
  }
  list(descriptor.runners, validateDockerRunnerRef, { max: 32 }); uniqueIds(descriptor.runners);
  list(descriptor.commands, validateCommandSpec, { max: 1024 }); uniqueIds(descriptor.commands);
  const modules = new Map(descriptor.modules.map(m => [m.id,m]));
  const runners = new Map(descriptor.runners.map(r => [r.id,r]));
  for (const command of descriptor.commands) {
    const module = modules.get(command.moduleId);
    if (!module || !runners.has(command.runnerId)) fail('project_command_reference_invalid');
    if (!within(command.cwd, module.root)) fail('project_command_cwd_outside_module');
    if (reserved(command.cwd) || protectedPaths.some(p => within(fold(command.cwd), p))) fail('project_command_cwd_protected');
  }
  return structuredClone(descriptor);
}

/** Deterministic JSON for these bounded contracts; ordered arrays stay ordered. */
export function contractDigest(value) {
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => [key,canonical(item[key])]));
    return item;
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}
export function projectDescriptorDigest(descriptor) { return contractDigest(validateProjectDescriptor(descriptor)); }
