/** Bounded read-only discovery. Markers suggest capabilities, not authorization. */
import { readdirSync, lstatSync } from 'node:fs';
import { fail } from '../../harness-contracts/src/source-identity.mjs';
import { assertProjectId, assertProjectPath, validateProjectDescriptor, projectDescriptorDigest } from '../../harness-contracts/src/project-descriptor.mjs';
import { projectRoot, checkedPath, readProjectFile, parseProjectJson } from './safe-files.mjs';

const MARKERS = Object.freeze({
  'package.json': 'node', 'pyproject.toml': 'python', 'requirements.txt': 'python', 'setup.cfg': 'python',
  'Cargo.toml': 'rust', 'go.mod': 'go', 'pom.xml': 'java', 'build.gradle': 'java', 'build.gradle.kts': 'java',
  'README.md': 'docs', 'compose.yaml': null, 'compose.yml': null, 'docker-compose.yml': null, 'docker-compose.yaml': null,
  'package-lock.json': null, 'pnpm-lock.yaml': null, 'yarn.lock': null, 'bun.lock': null, 'bun.lockb': null,
});
const LOCK_MANAGER = { 'package-lock.json':'npm', 'pnpm-lock.yaml':'pnpm', 'yarn.lock':'yarn', 'bun.lock':'bun', 'bun.lockb':'bun' };
const VALIDATION_SCRIPT = /(?:^|:|-)(?:test|tests|check|lint|typecheck|verify|validate|validation|quality|schema|migration|migrations|build)(?:$|:|-)/iu;
function assertModuleRoot(root) {
  assertProjectPath(root, { root: true });
  if (root.split('/').some(p => ['.git','.harness','.runtime','node_modules'].includes(p.toLowerCase()) || p.toLowerCase().startsWith('.env'))) fail('project_module_protected');
}
function packageSuggestions(pkg, markers) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) fail('project_package_shape_invalid');
  const locks = [...new Set(markers.map(p => LOCK_MANAGER[p]).filter(Boolean))];
  const declared = typeof pkg.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@[^\s]+$/u.exec(pkg.packageManager)?.[1] : null;
  const ambiguous = locks.length > 1 || (pkg.packageManager !== undefined && !declared) || (declared && locks.some(m => m !== declared));
  const manager = ambiguous ? null : declared ?? locks[0] ?? 'npm';
  const suggestions = [];
  if (manager && pkg.scripts !== undefined) {
    if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) fail('project_package_scripts_invalid');
    for (const name of Object.keys(pkg.scripts).sort()) {
      if (typeof pkg.scripts[name] !== 'string') fail('project_package_scripts_invalid');
      if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/u.test(name) || !VALIDATION_SCRIPT.test(name)) continue;
      suggestions.push({ executable: manager, argv: ['run', name], source: `package.json#scripts.${name}`, authorization: 'none', runnerId: null });
    }
  }
  return { packageManager: manager, commandSuggestions: suggestions, warnings: ambiguous ? ['package_manager_ambiguous'] : [] };
}

export function discoverProject(root, { projectId, repositoryId, moduleRoots = ['.'] } = {}) {
  assertProjectId(projectId); assertProjectId(repositoryId);
  if (!Array.isArray(moduleRoots) || !moduleRoots.length || moduleRoots.length > 128) fail('project_modules_invalid');
  moduleRoots.forEach(assertModuleRoot);
  if (new Set(moduleRoots.map(p => p.normalize('NFC').toLowerCase())).size !== moduleRoots.length) fail('project_module_root_duplicate');
  const absolute = projectRoot(root);
  const modules = [];
  for (const moduleRoot of [...moduleRoots].sort()) {
    const path = checkedPath(absolute, moduleRoot);
    if (!lstatSync(path).isDirectory()) fail('project_path_not_directory');
    const names = readdirSync(path);
    if (names.length > 4096) fail('project_directory_limit');
    const selected = names.filter(n => Object.hasOwn(MARKERS, n) || /\.(?:csproj|fsproj|vbproj)$/u.test(n)).sort();
    if (selected.length > 64) fail('project_marker_limit');
    const evidence = [], languages = new Set();
    let pkg = null;
    for (const name of selected) {
      const relative = moduleRoot === '.' ? name : `${moduleRoot}/${name}`;
      const file = readProjectFile(absolute, relative);
      evidence.push(file.evidence);
      const language = Object.hasOwn(MARKERS, name) ? MARKERS[name] : 'dotnet';
      if (language) languages.add(language);
      if (name === 'package.json') pkg = parseProjectJson(file.bytes);
    }
    if (languages.size > 1) languages.delete('docs');
    const suggestions = !selected.includes('package.json') ? { packageManager: null, commandSuggestions: [], warnings: [] } : packageSuggestions(pkg, selected);
    // Locks without package metadata do not imply an executable JavaScript project.
    modules.push({ root: moduleRoot, languages: [...languages].sort(), evidence, ...suggestions, runnerRequired: true });
  }
  return { schemaVersion: 'project-discovery/v1', projectId, repositoryId, status: 'PROPOSAL', analysisScope: 'explicit-module-roots-known-markers', authorization: 'none', remoteCalls: 0, processesSpawned: 0, modules, qualificationVerdict: null };
}

export function loadProjectDescriptor(root) {
  const absolute = projectRoot(root);
  const file = readProjectFile(absolute, '.agent-harness/project.json', { maxBytes: 1048576 });
  const descriptor = validateProjectDescriptor(parseProjectJson(file.bytes));
  return { descriptor, digest: projectDescriptorDigest(descriptor), fileEvidence: file.evidence, authorization: 'none', qualificationVerdict: null };
}
