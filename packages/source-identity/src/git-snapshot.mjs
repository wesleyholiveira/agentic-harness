import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, lstatSync, openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { assertObjectId, assertObjectFormat, assertRepositoryPath, fail } from '../../harness-contracts/src/source-identity.mjs';
import { createSourceIdentity, digestBytes, verifyLegacyManifest } from './codec.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function utf8(bytes) { try { return decoder.decode(bytes); } catch { fail('source_utf8_invalid'); } }
function positive(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) fail('source_limit_invalid');
  return result;
}
function readOnlyGitEnvironment() {
  const env = { ...process.env };
  // An inherited repository, replacement ref, prompt, or partial-clone fetch must
  // not change the meaning of a pinned object lookup. Do not print this object.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}
function canonicalRootKey(value) {
  const canonical = realpathSync(resolve(value)).replace(/^\\\\\?\\/u, '').replaceAll('\\', '/');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
function sameDirectoryIdentity(left, right) {
  try {
    const leftPath = realpathSync(resolve(left));
    const rightPath = realpathSync(resolve(right));
    const leftStat = lstatSync(leftPath, { bigint: true });
    const rightStat = lstatSync(rightPath, { bigint: true });
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
    const inodeAvailable = leftStat.dev !== 0n || leftStat.ino !== 0n || rightStat.dev !== 0n || rightStat.ino !== 0n;
    if (inodeAvailable && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) return true;
    return canonicalRootKey(leftPath) === canonicalRootKey(rightPath);
  } catch {
    return false;
  }
}
function readTree(root, options) {
  const timeout = positive(options.timeoutMs, 30_000);
  const maxEntries = positive(options.maxEntries, 100_000);
  const maxObjectBytes = positive(options.maxObjectBytes, 32 * 1024 * 1024);
  const maxTotalBytes = positive(options.maxTotalBytes, 256 * 1024 * 1024);
  const metadataLimit = positive(options.maxMetadataBytes, 16 * 1024 * 1024);
  const directory = realpathSync(resolve(root));
  const env = readOnlyGitEnvironment();
  let gitCommands = 0;
  function git(args, input, maxBuffer = metadataLimit) {
    gitCommands++;
    options.onGitCommand?.(args[0]);
    try {
      return execFileSync('git', ['-C', directory, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], { env, input, maxBuffer, timeout, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { fail(`source_git_command_failed:${args[0]}`); }
  }
  const toplevel = utf8(git(['rev-parse', '--show-toplevel'])).trim();
  if (!sameDirectoryIdentity(toplevel, directory)) fail('source_git_root_mismatch');
  const objectFormat = assertObjectFormat(utf8(git(['rev-parse', '--show-object-format'])).trim());
  const requested = options.commit ?? 'HEAD';
  if (requested !== 'HEAD') assertObjectId(requested, objectFormat);
  const commit = utf8(git(['rev-parse', '--verify', `${requested}^{commit}`])).trim();
  assertObjectId(commit, objectFormat);
  if (requested !== 'HEAD' && requested !== commit) fail('source_commit_mismatch');
  const tree = git(['ls-tree', '-r', '-z', '--full-tree', commit]);
  const records = [];
  let offset = 0;
  while (offset < tree.length) {
    const end = tree.indexOf(0, offset);
    if (end < 0) fail('source_git_tree_invalid');
    const tab = tree.indexOf(9, offset);
    if (tab < offset || tab >= end) fail('source_git_tree_invalid');
    const header = utf8(tree.subarray(offset, tab));
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]+)$/u.exec(header);
    if (!match) fail('source_git_tree_invalid');
    const [, mode, type, oid] = match;
    assertObjectId(oid, objectFormat);
    if ((mode === '160000') !== (type === 'commit')) fail('source_git_tree_invalid');
    const path = assertRepositoryPath(utf8(tree.subarray(tab + 1, end)));
    records.push({ path, mode, type, oid });
    if (records.length > maxEntries) fail('source_entries_limit_exceeded');
    offset = end + 1;
  }
  const objectIds = [...new Set(records.filter(r => r.type === 'blob').map(r => r.oid))];
  const objects = new Map();
  if (objectIds.length) {
    const request = `${objectIds.join('\n')}\n`;
    const sizes = utf8(git(['cat-file', '--batch-check'], request)).trimEnd().split('\n');
    if (sizes.length !== objectIds.length) fail('source_git_batch_invalid');
    let total = 0;
    const expected = sizes.map((line, index) => {
      const match = /^([a-f0-9]+) blob (0|[1-9][0-9]*)$/u.exec(line);
      if (!match || match[1] !== objectIds[index]) fail('source_git_batch_invalid');
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size > maxObjectBytes) fail('source_object_too_large');
      total += size;
      if (total > maxTotalBytes) fail('source_total_bytes_exceeded');
      return { oid: match[1], size };
    });
    // Header/trailer overhead is bounded separately. Binary object bodies are
    // length-framed, never split on newlines or decoded as UTF-8.
    const raw = git(['cat-file', '--batch'], request, total + objectIds.length * 128 + 1024);
    let cursor = 0;
    for (const { oid, size } of expected) {
      const end = raw.indexOf(10, cursor);
      if (end < 0 || utf8(raw.subarray(cursor, end)) !== `${oid} blob ${size}`) fail('source_git_batch_invalid');
      const start = end + 1; const stop = start + size;
      if (stop >= raw.length || raw[stop] !== 10) fail('source_git_batch_invalid');
      const content = raw.subarray(start, stop);
      const actualOid = createHash(objectFormat).update(`blob ${content.length}\0`).update(content).digest('hex');
      if (actualOid !== oid) fail('source_git_object_mismatch');
      objects.set(oid, content);
      cursor = stop + 1;
    }
    if (cursor !== raw.length) fail('source_git_batch_invalid');
  }
  return { directory, records, objects, commit, objectFormat, git, get gitCommands() { return gitCommands; } };
}
function entryFor(record, objects) {
  if (record.mode === '160000') return { path: record.path, kind: 'gitlink', mode: record.mode, objectId: record.oid };
  const bytes = objects.get(record.oid);
  if (!bytes) fail('source_git_object_missing');
  return { path: record.path, kind: record.mode === '120000' ? 'symlink' : 'file', mode: record.mode, bytes: bytes.length, sha256: digestBytes(bytes), ...(record.mode === '120000' ? { target: utf8(bytes) } : {}) };
}
/** Snapshot of immutable committed bytes only. Never a deployment/qualification PASS. */
export function snapshotGitSource(root, options = {}) {
  const source = readTree(root, options);
  const exclusions = options.exclusions ?? [];
  const entries = source.records.filter(r => !exclusions.includes(r.path)).map(r => entryFor(r, source.objects));
  const identity = createSourceIdentity(entries, { objectFormat: source.objectFormat, symlinkPolicy: options.symlinkPolicy ?? 'reject', exclusions });
  return { commit: source.commit, proofKind: 'committed-source-integrity', workingTreeChecked: false, qualificationVerdict: null, gitCommands: source.gitCommands, identity };
}

/**
 * Reads selected regular files from the same immutable Git object snapshot used
 * to compute source identity. The selected bytes never come from the worktree.
 * This proves committed-source provenance only; it does not prove that a mutable
 * workspace currently equals the commit.
 */
export function readGitSourceFiles(root, options = {}) {
  const requestedPaths = options.paths ?? [];
  if (!Array.isArray(requestedPaths) || requestedPaths.length === 0 || requestedPaths.length > 128) fail('source_selected_paths_invalid');
  const unique = new Set();
  for (const path of requestedPaths) {
    assertRepositoryPath(path);
    if (unique.has(path)) fail('source_selected_paths_invalid');
    unique.add(path);
  }
  const source = readTree(root, options);
  const exclusions = options.exclusions ?? [];
  const entries = source.records.filter(record => !exclusions.includes(record.path)).map(record => entryFor(record, source.objects));
  const identity = createSourceIdentity(entries, {
    objectFormat: source.objectFormat,
    symlinkPolicy: options.symlinkPolicy ?? 'reject',
    exclusions,
  });
  const records = new Map(source.records.map(record => [record.path, record]));
  const files = requestedPaths.map(path => {
    const record = records.get(path);
    if (!record || !['100644','100755'].includes(record.mode) || record.type !== 'blob') fail('source_selected_file_missing_or_not_regular');
    const bytes = source.objects.get(record.oid);
    if (!bytes) fail('source_git_object_missing');
    return { path, mode: record.mode, bytes: Buffer.from(bytes), sha256: digestBytes(bytes) };
  });
  return {
    commit: source.commit,
    objectFormat: source.objectFormat,
    proofKind: 'committed-source-selected-files',
    workingTreeChecked: false,
    qualificationVerdict: null,
    gitCommands: source.gitCommands,
    identity,
    files,
  };
}
/** Compatibility verifier. v1 does not bind file modes, so never claim v2 proof. */
export function verifyGitManifest(root, options = {}) {
  const source = readTree(root, options);
  const manifestRecord = source.records.find(record => record.path === 'MANIFEST.json');
  if (!manifestRecord || !['100644', '100755'].includes(manifestRecord.mode)) fail('source_manifest_missing_or_invalid_mode');
  let parsed;
  try { parsed = JSON.parse(utf8(source.objects.get(manifestRecord.oid))); } catch { fail('source_manifest_json_invalid'); }
  const manifest = verifyLegacyManifest(parsed);
  const records = source.records.filter(r => r.path !== 'MANIFEST.json');
  const files = new Map(manifest.files.map(file => [file.path, file]));
  if (records.length !== files.size || records.some(r => !files.has(r.path))) fail('source_manifest_catalog_mismatch');
  for (const record of records) {
    if (!['100644', '100755'].includes(record.mode)) fail('source_legacy_mode_unsupported');
    const expected = files.get(record.path); const content = source.objects.get(record.oid);
    if (expected.bytes !== content.length || expected.sha256 !== digestBytes(content)) fail('source_blob_identity_mismatch');
  }
  // Gate observed HEAD, index and physical bytes: a stale pin or ordinary dirty
  // working tree is not an admissible source-integrity observation. This is not a lock
  // against concurrent writers; caller must hold its workspace lease.
  const head = utf8(source.git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (head !== source.commit) fail('source_worktree_commit_mismatch');
  const index = utf8(source.git(['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
  const indexExpected = new Map(source.records.map(r => [r.path, `${r.mode} ${r.oid} 0`]));
  if (index.length !== indexExpected.size) fail('source_worktree_dirty');
  for (const line of index) {
    const tab = line.indexOf('\t');
    if (tab < 0 || indexExpected.get(line.slice(tab + 1)) !== line.slice(0, tab)) fail('source_worktree_dirty');
    indexExpected.delete(line.slice(tab + 1));
  }
  if (indexExpected.size || source.git(['ls-files', '--others', '--exclude-standard', '-z']).length) fail('source_worktree_dirty');
  // Raw physical bytes, not `git status`, also catch assume-unchanged,
  // skip-worktree, symlink swaps and content hidden by clean/smudge filters.
  // This deliberately stricter compatibility check rejects filtered/CRLF
  // worktrees rather than asserting they are byte-exact installations.
  for (const record of source.records) {
    let path = source.directory;
    const segments = record.path.split('/');
    for (const segment of segments.slice(0, -1)) {
      path = join(path, segment);
      let stat;
      try { stat = lstatSync(path); } catch { fail('source_worktree_file_invalid'); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('source_worktree_file_invalid');
    }
    path = join(path, segments.at(-1));
    let fd;
    try {
      const before = lstatSync(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) fail('source_worktree_file_invalid');
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd, { bigint: true });
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) fail('source_worktree_file_invalid');
      if (stat.size !== BigInt(source.objects.get(record.oid).length)) fail('source_worktree_bytes_mismatch');
      const bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) fail('source_worktree_changed_during_verification');
      if (!bytes.equals(source.objects.get(record.oid))) fail('source_worktree_bytes_mismatch');
      if (process.platform !== 'win32' && Boolean(Number(stat.mode) & 0o111) !== (record.mode === '100755')) fail('source_worktree_mode_mismatch');
    } catch (error) {
      if (error?.code?.startsWith('source_')) throw error;
      fail('source_worktree_file_invalid');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const headAfter = utf8(source.git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (headAfter !== head) fail('source_worktree_changed_during_verification');
  return { ok: true, commit: source.commit, fileCount: manifest.fileCount, treeSha256: manifest.treeSha256, modeBound: false, workingTreeChecked: true, worktreePolicy: 'byte-exact', gitCommands: source.gitCommands, qualificationVerdict: null };
}
