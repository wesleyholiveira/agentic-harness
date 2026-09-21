import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  canonicalLegacyFiles, legacyManifestTreeDigest, verifyLegacyManifest,
  createSourceIdentity, verifySourceIdentity,
} from '../../packages/source-identity/src/codec.mjs';
import { snapshotGitSource, verifyGitManifest } from '../../packages/source-identity/src/git-snapshot.mjs';

const sha = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const file = (path, content = 'content', mode = '100644') => ({ path, kind: 'file', mode, bytes: Buffer.byteLength(content), sha256: sha(content) });
const legacy = (path, content = 'content') => ({ path, bytes: Buffer.byteLength(content), sha256: sha(content) });
function manifest(files) {
  return { schemaVersion: 'agentic-harness-distribution-manifest/v1', sourceAuthority: 'git-tracked-worktree', fileCount: files.length, treeSha256: legacyManifestTreeDigest(files), files };
}
function repo(t, objectFormat = 'sha1') {
  const root = mkdtempSync(join(tmpdir(), 'source-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const testEnv = { ...process.env };
  for (const key of Object.keys(testEnv)) if (key.startsWith('GIT_')) delete testEnv[key];
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...testEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', `--object-format=${objectFormat}`]);
  git(['config', 'user.name', 'Source Identity Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'commit.gpgsign', 'false']);
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  const commit = () => { git(['add', '.']); git(['commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  return { root, git, put, commit };
}

test('legacy manifest property order is canonical while historical array order stays authoritative', () => {
  const a = legacy('z.md', 'z'); const b = legacy('a.md', 'a');
  const reordered = [{ sha256: a.sha256, path: a.path, bytes: a.bytes }, b];
  assert.equal(legacyManifestTreeDigest(reordered), legacyManifestTreeDigest([a, b]));
  assert.notEqual(legacyManifestTreeDigest([a, b]), legacyManifestTreeDigest([b, a]));
  assert.deepEqual(Object.keys(canonicalLegacyFiles([a])[0]), ['bytes', 'path', 'sha256']);
  assert.notEqual(sha(JSON.stringify([a, b])), legacyManifestTreeDigest([a, b]), 'reproduce pre-existing consumer raw-property-order mismatch');
});

test('legacy parser verifies fields and digest without modifying caller data', () => {
  const input = manifest([legacy('doc.md')]); const before = JSON.stringify(input);
  assert.equal(verifyLegacyManifest(input).fileCount, 1);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => verifyLegacyManifest({ ...input, fileCount: 2 }), /source_manifest_count_mismatch/);
  assert.throws(() => verifyLegacyManifest({ ...input, treeSha256: sha('tampered') }), /source_manifest_digest_mismatch/);
  assert.throws(() => verifyLegacyManifest({ ...input, schemaVersion: 'v999' }), /source_manifest_version_unsupported/);
});

for (const path of ['../escape', '/absolute', 'C:/file', 'C:file', 'a\\b', 'a//b', 'a/./b', 'a/../b', '.git/config', 'x/.GIT/config', 'line\nname', 'bad\ud800']) {
  test(`unsafe path is rejected (${JSON.stringify(path)})`, () => assert.throws(() => createSourceIdentity([file(path)]), /source_path_invalid/));
}

test('duplicate paths, unknown fields, non-finite size and inconsistent mode fail closed', () => {
  assert.throws(() => createSourceIdentity([file('a'), file('a')]), /source_duplicate_path/);
  assert.throws(() => canonicalLegacyFiles([{ ...legacy('a'), ignored: true }]), /source_entry_unknown_field/);
  assert.throws(() => createSourceIdentity([{ ...file('a'), bytes: Infinity }]), /source_entry_size_invalid/);
  assert.throws(() => createSourceIdentity([{ ...file('a'), mode: '160000' }]), /source_entry_mode_invalid/);
});

test('v2 entry/key order is deterministic and mode changes affect identity', () => {
  const entries = [file('é.md'), file('Z.md'), file('a.md')];
  const identity = createSourceIdentity(entries);
  assert.equal(identity.treeSha256, createSourceIdentity(entries.toReversed()).treeSha256);
  assert.deepEqual(identity.entries.map(x => x.path), ['Z.md', 'a.md', 'é.md']);
  assert.notEqual(createSourceIdentity([file('a.sh')]).treeSha256, createSourceIdentity([file('a.sh', 'content', '100755')]).treeSha256);
  assert.equal(verifySourceIdentity(JSON.parse(JSON.stringify(identity))).treeSha256, identity.treeSha256);
});

test('v2 contract, object format and exclusions are part of identity', () => {
  const entries = [file('a')];
  assert.notEqual(createSourceIdentity(entries).treeSha256, createSourceIdentity(entries, { objectFormat: 'sha256' }).treeSha256);
  assert.notEqual(createSourceIdentity(entries).treeSha256, createSourceIdentity(entries, { exclusions: ['MANIFEST.json'] }).treeSha256);
  assert.throws(() => createSourceIdentity(entries, { exclusions: ['a'] }), /source_exclusion_present/);
  assert.throws(() => verifySourceIdentity({ ...createSourceIdentity(entries), qualificationVerdict: 'PASS' }), /source_identity_unknown_field/);
  assert.throws(() => verifySourceIdentity({ ...createSourceIdentity(entries), schemaVersion: 'v999' }), /source_identity_version_unsupported/);
});

test('symlinks are not dereferenced and require explicit internal-only policy', () => {
  const target = 'README.md';
  const link = { path: 'link.md', kind: 'symlink', mode: '120000', target, bytes: Buffer.byteLength(target), sha256: sha(target) };
  assert.throws(() => createSourceIdentity([file('README.md'), link]), /source_symlink_not_allowed/);
  const identity = createSourceIdentity([file('README.md'), link], { symlinkPolicy: 'internal-file' });
  assert.equal(identity.entries.find(x => x.path === 'link.md').target, target);
  const escaped = { ...link, target: '../outside', bytes: 10, sha256: sha('../outside') };
  assert.throws(() => createSourceIdentity([file('README.md'), escaped], { symlinkPolicy: 'internal-file' }), /source_symlink_target_invalid/);
  assert.throws(() => createSourceIdentity([link], { symlinkPolicy: 'internal-file' }), /source_symlink_target_not_regular/);
});

test('symlink bytes must match declared target and nested aliases cannot hide paths', () => {
  const link = { path: 'alias', kind: 'symlink', mode: '120000', target: 'a', bytes: 1, sha256: sha('a') };
  assert.throws(() => createSourceIdentity([file('a'), { ...link, sha256: sha('b') }], { symlinkPolicy: 'internal-file' }), /source_symlink_identity_mismatch/);
  assert.throws(() => createSourceIdentity([file('a'), link, file('alias/child')], { symlinkPolicy: 'internal-file' }), /source_path_parent_conflict/);
});

test('record-only symlink policy binds link bytes without authorizing dereference', () => {
  const target = '../outside';
  const link = { path: 'external-link', kind: 'symlink', mode: '120000', target, bytes: Buffer.byteLength(target), sha256: sha(target) };
  const identity = createSourceIdentity([link], { symlinkPolicy: 'record-only' });
  assert.equal(identity.entries[0].target, target);
  assert.equal(identity.entries[0].kind, 'symlink');
  assert.throws(() => createSourceIdentity([{ ...link, sha256: sha('different') }], { symlinkPolicy: 'record-only' }), /source_symlink_identity_mismatch/);
});

test('gitlink is a pinned commit identity, not invented nested file content', () => {
  const entry = { path: '.harness', kind: 'gitlink', mode: '160000', objectId: 'a'.repeat(40) };
  const a = createSourceIdentity([entry]);
  const b = createSourceIdentity([{ ...entry, objectId: 'b'.repeat(40) }]);
  assert.notEqual(a.treeSha256, b.treeSha256);
  assert.throws(() => createSourceIdentity([{ ...entry, bytes: 0 }]), /source_entry_unknown_field/);
  assert.throws(() => createSourceIdentity([entry], { objectFormat: 'sha256' }), /source_object_id_invalid/);
});

test('binary bytes, Unicode names and executable mode are read from Git blobs in a bounded batch', t => {
  const r = repo(t);
  r.put('src/é x.bin', Buffer.from([0, 10, 13, 255, 65]));
  r.put('script.sh', '#!/bin/sh\nexit 0\n');
  r.git(['add', '.']); r.git(['update-index', '--chmod=+x', 'script.sh']); r.git(['commit', '-m', 'fixture']);
  const calls = [];
  const result = snapshotGitSource(r.root, { onGitCommand: name => calls.push(name) });
  assert.equal(result.identity.entries.find(e => e.path === 'script.sh').mode, '100755');
  assert.equal(result.identity.entries.find(e => e.path === 'src/é x.bin').sha256, sha(Buffer.from([0, 10, 13, 255, 65])));
  assert.equal(calls.filter(x => x === 'cat-file').length, 2);
  assert.equal(result.proofKind, 'committed-source-integrity');
  assert.equal(result.qualificationVerdict, null);
  assert.equal(result.workingTreeChecked, false);
});

test('batch process count does not grow with file count', t => {
  const r = repo(t); for (let i = 0; i < 80; i++) r.put(`f-${i}.txt`, `value-${i}`); r.commit();
  const calls = [];
  assert.equal(snapshotGitSource(r.root, { onGitCommand: name => calls.push(name) }).identity.entryCount, 80);
  assert.equal(calls.length, 6, JSON.stringify(calls));
});

test('committed snapshot is independent of dirty worktree and verifier rejects dirty state', t => {
  const r = repo(t); r.put('a', 'approved'); r.put('MANIFEST.json', JSON.stringify(manifest([legacy('a', 'approved')]))); const commit = r.commit();
  assert.equal(verifyGitManifest(r.root, { commit }).fileCount, 1);
  r.put('a', 'modified');
  assert.equal(snapshotGitSource(r.root, { commit }).identity.entries.find(x => x.path === 'a').sha256, sha('approved'));
  assert.throws(() => verifyGitManifest(r.root, { commit }), /source_worktree_bytes_mismatch/);
});

test('v1 verifier catches extra committed files and blob mismatch', t => {
  const r = repo(t); r.put('a', 'bad'); r.put('MANIFEST.json', JSON.stringify(manifest([legacy('a', 'good')]))); r.commit();
  assert.throws(() => verifyGitManifest(r.root), /source_blob_identity_mismatch/);
  r.put('a', 'good'); r.put('extra', 'x'); r.commit();
  assert.throws(() => verifyGitManifest(r.root), /source_manifest_catalog_mismatch/);
});

test('a submodule gitlink does not need its commit objects present in the parent', t => {
  const r = repo(t); r.put('file', 'x'); r.commit();
  r.git(['update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},.harness`]); r.git(['commit', '-m', 'gitlink']);
  const entry = snapshotGitSource(r.root).identity.entries.find(x => x.path === '.harness');
  assert.equal(entry.kind, 'gitlink'); assert.equal(entry.objectId, 'b'.repeat(40));
});

test('explicit object budgets fail instead of allocating unbounded aggregate output', t => {
  const r = repo(t); r.put('large', 'x'.repeat(3000)); r.commit();
  assert.throws(() => snapshotGitSource(r.root, { maxObjectBytes: 1000 }), /source_object_too_large/);
  assert.throws(() => snapshotGitSource(r.root, { maxTotalBytes: 2000 }), /source_total_bytes_exceeded/);
});

test('Git SHA-256 object format is detected, not assumed to be SHA-1', t => {
  const r = repo(t, 'sha256'); r.put('a', 'content'); const commit = r.commit();
  const result = snapshotGitSource(r.root, { commit });
  assert.equal(result.identity.objectFormat, 'sha256'); assert.equal(result.commit.length, 64);
});

test('Git replace refs cannot substitute a different tree for a pinned commit', t => {
  const r = repo(t); r.put('a', 'before'); const before = r.commit(); r.put('a', 'after'); const after = r.commit();
  r.git(['replace', before, after]);
  assert.equal(snapshotGitSource(r.root, { commit: before }).identity.entries[0].sha256, sha('before'));
});

test('read-only CLI reports integrity, not qualification, and rejects unknown flags', t => {
  const r = repo(t); r.put('a', 'content'); r.put('MANIFEST.json', JSON.stringify(manifest([legacy('a')]))); const commit = r.commit();
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/source-identity/bin/verify.mjs');
  const result = spawnSync(process.execPath, [cli, '--root', r.root, '--commit', commit], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout); assert.equal(data.integrity.ok, true); assert.equal(data.qualificationVerdict, null);
  const invalid = spawnSync(process.execPath, [cli, '--root', r.root, '--force'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /source_cli_argument_invalid/);
  assert.equal(r.git(['status', '--porcelain']), '');
});

test('assume-unchanged cannot hide modified worktree bytes from the verifier', t => {
  const r = repo(t); r.put('a', 'approved'); r.put('MANIFEST.json', JSON.stringify(manifest([legacy('a', 'approved')]))); r.commit();
  r.git(['update-index', '--assume-unchanged', 'a']); r.put('a', 'tampered');
  assert.equal(r.git(['status', '--porcelain']), '');
  assert.throws(() => verifyGitManifest(r.root), /source_worktree_(bytes_mismatch|dirty)/);
});

test('skip-worktree cannot hide missing files from the verifier', t => {
  const r = repo(t); r.put('a', 'approved'); r.put('MANIFEST.json', JSON.stringify(manifest([legacy('a', 'approved')]))); r.commit();
  r.git(['update-index', '--skip-worktree', 'a']); rmSync(join(r.root, 'a'));
  assert.throws(() => verifyGitManifest(r.root), /source_worktree_(file_invalid|dirty)/);
});

test('staged changes cannot pass with unchanged committed manifest', t => {
  const r = repo(t); r.put('a', 'approved'); r.put('MANIFEST.json', JSON.stringify(manifest([legacy('a', 'approved')]))); r.commit();
  r.put('a', 'next'); r.git(['add', 'a']);
  assert.throws(() => verifyGitManifest(r.root), /source_worktree_dirty/);
});

test('historical commit may be snapshotted, but cannot masquerade as installed HEAD', t => {
  const r = repo(t); r.put('a', 'before'); r.put('MANIFEST.json', JSON.stringify(manifest([legacy('a', 'before')]))); const first = r.commit();
  r.put('a', 'after'); const last = r.commit();
  assert.equal(snapshotGitSource(r.root, { commit: first }).commit, first);
  assert.throws(() => verifyGitManifest(r.root, { commit: first }), /source_worktree_commit_mismatch/);
  assert.equal(r.git(['rev-parse', 'HEAD']), last);
});

test('source bytes preserve line endings and do not normalize Unicode content', () => {
  assert.notEqual(createSourceIdentity([file('a', 'line\r\n')]).treeSha256, createSourceIdentity([file('a', 'line\n')]).treeSha256);
  assert.notEqual(createSourceIdentity([file('a', '\u00e9')]).treeSha256, createSourceIdentity([file('a', 'e\u0301')]).treeSha256);
});

test('case-colliding paths are rejected by the portable v2 contract', () => {
  assert.throws(() => createSourceIdentity([file('README.md'), file('readme.md')]), /source_portable_path_collision/);
});

for (const path of ['foo:bar', 'CON', 'dir/AUX.txt', 'trail.', 'trail ', 'name?']) {
  test(`non-portable path rejected (${path})`, () => assert.throws(() => createSourceIdentity([file(path)]), /source_path_invalid/));
}

test('worktree verification never invokes configured clean filters', t => {
  const r = repo(t); r.put('a', 'approved'); r.put('MANIFEST.json', JSON.stringify(manifest([legacy('a', 'approved')]))); r.commit();
  // A status/refresh-based verifier would invoke this command. Raw byte checks
  // and ls-files do not run the filter at all, regardless of its definition.
  r.git(['config', 'filter.sentinel.clean', 'exit 71']);
  r.git(['config', 'filter.sentinel.required', 'true']);
  r.put('.git/info/attributes', 'a filter=sentinel\n');
  r.put('a', 'tampered');
  assert.throws(() => verifyGitManifest(r.root), /source_worktree_bytes_mismatch/);
});

test('inherited Git repository/index variables do not redirect object reads', t => {
  const r = repo(t); const other = repo(t); r.put('a', 'expected'); const commit = r.commit(); other.put('b', 'wrong'); other.commit();
  const prior = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  try {
    process.env.GIT_DIR = join(other.root, '.git'); process.env.GIT_WORK_TREE = other.root; process.env.GIT_INDEX_FILE = join(other.root, '.git/index');
    assert.equal(snapshotGitSource(r.root, { commit }).identity.entries[0].path, 'a');
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('HEAD or a full object ID is required: arbitrary refs/options are not accepted', t => {
  const r = repo(t); r.put('a', 'x'); r.commit();
  for (const commit of ['main', '--all', 'HEAD~1', 'HEAD:MANIFEST.json']) assert.throws(() => snapshotGitSource(r.root, { commit }), /source_object_id_invalid/);
});

function generatorFixture(t) {
  const r = repo(t);
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  for (const path of ['scripts/internal/source-manifest.mjs', 'packages/source-identity/src/codec.mjs', 'packages/harness-contracts/src/source-identity.mjs']) r.put(path, readFileSync(join(sourceRoot, path)));
  r.put('data.txt', 'fixture'); r.git(['add', '.']);
  r.generate = mode => spawnSync(process.execPath, [join(r.root, 'scripts/internal/source-manifest.mjs'), mode], { encoding: 'utf8', env: { ...process.env, AGENT_HARNESS_ROOT: r.root } });
  return r;
}

test('official generator shares the compatibility codec and still requires tracked clean source', t => {
  const r = generatorFixture(t);
  const write = r.generate('--write'); assert.equal(write.status, 0, write.stderr);
  assert.notEqual(r.generate('--check').status, 0);
  const commit = r.commit();
  const check = r.generate('--check'); assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(verifyGitManifest(r.root, { commit }).treeSha256, JSON.parse(check.stdout).expectedTreeSha256);
});

test('official check rejects unknown per-file fields instead of silently dropping them', t => {
  const r = generatorFixture(t); assert.equal(r.generate('--write').status, 0); r.commit();
  const value = JSON.parse(readFileSync(join(r.root, 'MANIFEST.json'), 'utf8'));
  value.files[0].permission = 'approved'; r.put('MANIFEST.json', JSON.stringify(value)); r.commit();
  const result = r.generate('--check'); assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /source_entry_unknown_field/);
});

test('official generator does not reinterpret unknown manifest versions as v1', t => {
  const r = generatorFixture(t); assert.equal(r.generate('--write').status, 0); r.commit();
  const value = JSON.parse(readFileSync(join(r.root, 'MANIFEST.json'), 'utf8'));
  value.schemaVersion = 'future/v999'; r.put('MANIFEST.json', JSON.stringify(value)); r.commit();
  const result = r.generate('--check'); assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /source_manifest_version_unsupported/);
});

test('v1 generator explicitly rejects a symlink-index entry rather than hashing target file bytes', t => {
  const r = generatorFixture(t); r.put('link', 'data.txt'); r.git(['add', '.']);
  const oid = r.git(['hash-object', 'link']);
  r.git(['update-index', '--cacheinfo', `120000,${oid},link`]);
  const result = r.generate('--write');
  assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /agent_harness_source_entry_kind_unsupported/);
});

test('manifest itself may not be a symlink-index entry', t => {
  const r = generatorFixture(t); assert.equal(r.generate('--write').status, 0); r.git(['add', '.']);
  const oid = r.git(['hash-object', 'MANIFEST.json']);
  r.git(['update-index', '--cacheinfo', `120000,${oid},MANIFEST.json`]);
  const result = r.generate('--write');
  assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /agent_harness_source_entry_kind_unsupported/);
});

test('official check rejects a forged fileCount even when file entries and digest match', t => {
  const r = generatorFixture(t); assert.equal(r.generate('--write').status, 0); r.commit();
  const value = JSON.parse(readFileSync(join(r.root, 'MANIFEST.json'), 'utf8'));
  value.fileCount = 0; r.put('MANIFEST.json', JSON.stringify(value)); r.commit();
  const result = r.generate('--check'); assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).code, 'agent_harness_manifest_source_mismatch');
});
