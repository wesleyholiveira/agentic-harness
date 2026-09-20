import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  SOURCE_IDENTITY_VERSION, LEGACY_MANIFEST_VERSION, SOURCE_DIGEST_ALGORITHM,
  assertKeys, assertRecord, assertSize, assertSha256, assertRepositoryPath,
  assertObjectFormat, assertSourceEntry, assertSymlinkPolicy, fail,
} from '../../harness-contracts/src/source-identity.mjs';

export const digestBytes = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// No locale-dependent collation or Unicode normalization: Git path bytes are identity.
export const compareUtf8Paths = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Legacy v1 keeps its declared ARRAY order, but never its property insertion order. */
export function canonicalLegacyFiles(files) {
  if (!Array.isArray(files)) fail('source_manifest_files_invalid');
  const paths = new Set();
  return files.map(entry => {
    assertKeys(entry, ['bytes', 'path', 'sha256']);
    assertRepositoryPath(entry.path); assertSize(entry.bytes); assertSha256(entry.sha256);
    if (entry.path === 'MANIFEST.json') fail('source_manifest_self_reference');
    if (paths.has(entry.path)) fail('source_duplicate_path');
    paths.add(entry.path);
    return { bytes: entry.bytes, path: entry.path, sha256: entry.sha256 };
  });
}
export function legacyManifestTreeDigest(files) {
  return digestBytes(Buffer.from(JSON.stringify(canonicalLegacyFiles(files)), 'utf8'));
}
export function verifyLegacyManifest(manifest) {
  assertRecord(manifest, 'source_manifest_invalid');
  if (manifest.schemaVersion !== LEGACY_MANIFEST_VERSION) fail('source_manifest_version_unsupported');
  if (manifest.sourceAuthority !== 'git-tracked-worktree') fail('source_manifest_authority_invalid');
  const files = canonicalLegacyFiles(manifest.files);
  if (manifest.fileCount !== files.length) fail('source_manifest_count_mismatch');
  assertSha256(manifest.treeSha256);
  if (legacyManifestTreeDigest(files) !== manifest.treeSha256) fail('source_manifest_digest_mismatch');
  // Top-level legacy distribution metadata is deliberately not treated as permission.
  return { schemaVersion: manifest.schemaVersion, sourceAuthority: manifest.sourceAuthority, fileCount: files.length, treeSha256: manifest.treeSha256, files };
}

function canonicalEntries(entries, objectFormat, symlinkPolicy, exclusions) {
  if (!Array.isArray(entries)) fail('source_entries_invalid');
  const paths = new Map();
  const portableNames = new Set();
  const output = entries.map(entry => {
    assertSourceEntry(entry, objectFormat);
    if (paths.has(entry.path)) fail('source_duplicate_path');
    const portableName = entry.path.normalize('NFC').toLowerCase();
    if (portableNames.has(portableName)) fail('source_portable_path_collision');
    portableNames.add(portableName);
    if (exclusions.includes(entry.path)) fail('source_exclusion_present');
    let canonical;
    if (entry.kind === 'gitlink') canonical = { path: entry.path, kind: entry.kind, mode: entry.mode, objectId: entry.objectId };
    else canonical = { path: entry.path, kind: entry.kind, mode: entry.mode, bytes: entry.bytes, sha256: entry.sha256, ...(entry.kind === 'symlink' ? { target: entry.target } : {}) };
    paths.set(entry.path, canonical);
    return canonical;
  });
  for (const entry of output) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) fail('source_path_parent_conflict');
    if (entry.kind !== 'symlink') continue;
    if (symlinkPolicy === 'reject') fail('source_symlink_not_allowed');
    if (/^[A-Za-z]:|^\/|[\\\u0000-\u001f\u007f]/u.test(entry.target)) fail('source_symlink_target_invalid');
    const target = posix.normalize(posix.join(posix.dirname(entry.path), entry.target));
    try { assertRepositoryPath(target); } catch { fail('source_symlink_target_invalid'); }
    // Explicit, narrow policy: no directory links, chains, loops, or missing targets.
    if (paths.get(target)?.kind !== 'file') fail('source_symlink_target_not_regular');
    const bytes = Buffer.from(entry.target, 'utf8');
    if (bytes.length !== entry.bytes || digestBytes(bytes) !== entry.sha256) fail('source_symlink_identity_mismatch');
  }
  return output.sort((a, b) => compareUtf8Paths(a.path, b.path));
}
function canonicalExclusions(exclusions) {
  if (!Array.isArray(exclusions)) fail('source_exclusions_invalid');
  exclusions.forEach(assertRepositoryPath);
  if (new Set(exclusions).size !== exclusions.length) fail('source_duplicate_exclusion');
  return [...exclusions].sort(compareUtf8Paths);
}
export function createSourceIdentity(entries, options = {}) {
  assertKeys(options, [], ['objectFormat', 'symlinkPolicy', 'exclusions'], 'source_options_invalid');
  const objectFormat = assertObjectFormat(options.objectFormat ?? 'sha1');
  const symlinkPolicy = assertSymlinkPolicy(options.symlinkPolicy ?? 'reject');
  const exclusions = canonicalExclusions(options.exclusions ?? []);
  const canonical = canonicalEntries(entries, objectFormat, symlinkPolicy, exclusions);
  const payload = { schemaVersion: SOURCE_IDENTITY_VERSION, hashAlgorithm: SOURCE_DIGEST_ALGORITHM, objectFormat, symlinkPolicy, exclusions, entryCount: canonical.length, entries: canonical };
  return { ...payload, treeSha256: digestBytes(Buffer.from(JSON.stringify(payload), 'utf8')) };
}
export function verifySourceIdentity(identity) {
  assertKeys(identity, ['schemaVersion', 'hashAlgorithm', 'objectFormat', 'symlinkPolicy', 'exclusions', 'entryCount', 'entries', 'treeSha256'], [], 'source_identity_unknown_field');
  if (identity.schemaVersion !== SOURCE_IDENTITY_VERSION || identity.hashAlgorithm !== SOURCE_DIGEST_ALGORITHM) fail('source_identity_version_unsupported');
  assertSha256(identity.treeSha256);
  const canonical = createSourceIdentity(identity.entries, { objectFormat: identity.objectFormat, symlinkPolicy: identity.symlinkPolicy, exclusions: identity.exclusions });
  if (canonical.entryCount !== identity.entryCount) fail('source_identity_count_mismatch');
  if (canonical.treeSha256 !== identity.treeSha256) fail('source_identity_digest_mismatch');
  return canonical;
}
