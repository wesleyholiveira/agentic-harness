import { assertKeys, fail } from './source-identity.mjs';
import {
  assertProjectId, assertProjectPath, contractDigest, validateCommandSpec,
} from './project-descriptor.mjs';
import { validateDockerRunnerSpec } from './docker-runner-v2.mjs';

export const PROJECT_DESCRIPTOR_V2 = 'project-descriptor/v2';

function list(value, validate, { min = 0, max = 128 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('project_v2_array_invalid');
  for (const item of value) validate(item);
  if (new Set(value).size !== value.length) fail('project_v2_array_duplicate');
}
function fold(path) { return path.normalize('NFC').toLowerCase(); }
function within(path, parent) { return parent === '.' || path === parent || path.startsWith(`${parent}/`); }
function reserved(path) {
  return fold(path).split('/').some(part => ['.git','.harness','.agent-harness','.runtime','node_modules'].includes(part) || part.startsWith('.env'));
}
function uniqueIds(items) {
  const ids = items.map(item => item.id);
  if (new Set(ids).size !== ids.length) fail('project_v2_id_duplicate');
}

export function validateProjectDescriptorV2(descriptor) {
  assertKeys(descriptor, [
    'schemaVersion','projectId','repositoryId','policyRef','modules','evidenceRoots',
    'protectedPaths','runners','commands',
  ], [], 'project_v2_descriptor_shape_invalid');
  if (descriptor.schemaVersion !== PROJECT_DESCRIPTOR_V2) fail('project_v2_descriptor_version_unsupported');
  assertProjectId(descriptor.projectId);
  assertProjectId(descriptor.repositoryId);
  assertProjectPath(descriptor.policyRef);
  if (!descriptor.policyRef.startsWith('.agent-harness/') || descriptor.policyRef.toLowerCase().includes('/.env')) fail('project_v2_policy_ref_invalid');

  list(descriptor.modules, module => {
    assertKeys(module, ['id','root','languages','requiredCapabilities'], [], 'project_v2_module_shape_invalid');
    assertProjectId(module.id);
    assertProjectPath(module.root, { root: true });
    list(module.languages, language => {
      if (typeof language !== 'string' || !/^[a-z][a-z0-9+.-]{0,63}$/u.test(language)) fail('project_v2_language_invalid');
    }, { min: 1 });
    list(module.requiredCapabilities, assertProjectId);
  }, { min: 1 });
  uniqueIds(descriptor.modules);
  if (new Set(descriptor.modules.map(module => fold(module.root))).size !== descriptor.modules.length) fail('project_v2_module_root_duplicate');

  list(descriptor.evidenceRoots, path => assertProjectPath(path, { root: true }));
  list(descriptor.protectedPaths, assertProjectPath);
  const protectedPaths = ['.git','.harness','.agent-harness','.runtime','node_modules', ...descriptor.protectedPaths].map(fold);
  for (const module of descriptor.modules) {
    if (reserved(module.root) || protectedPaths.some(path => within(fold(module.root), path))) fail('project_v2_module_protected');
  }

  list(descriptor.runners, validateDockerRunnerSpec, { min: 1, max: 32 });
  uniqueIds(descriptor.runners);
  list(descriptor.commands, validateCommandSpec, { max: 1024 });
  uniqueIds(descriptor.commands);

  const modules = new Map(descriptor.modules.map(module => [module.id, module]));
  const runners = new Map(descriptor.runners.map(runner => [runner.id, runner]));
  for (const command of descriptor.commands) {
    const module = modules.get(command.moduleId);
    if (!module || !runners.has(command.runnerId)) fail('project_v2_command_reference_invalid');
    if (!within(command.cwd, module.root)) fail('project_v2_command_cwd_outside_module');
    if (reserved(command.cwd) || protectedPaths.some(path => within(fold(command.cwd), path))) fail('project_v2_command_cwd_protected');
  }
  return structuredClone(descriptor);
}

export function projectDescriptorV2Digest(descriptor) {
  return contractDigest(validateProjectDescriptorV2(descriptor));
}
