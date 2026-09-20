/** Pure contracts. No Git, filesystem, model, network, or implicit authorization. */
export const SOURCE_IDENTITY_VERSION = 'agentic-harness-source-identity/v2';
export const LEGACY_MANIFEST_VERSION = 'agentic-harness-distribution-manifest/v1';
export const SOURCE_DIGEST_ALGORITHM = 'sha256:source-identity-v2:canonical-json-utf8';

export class SourceIdentityError extends Error {
  constructor(code) { super(code); this.name = 'SourceIdentityError'; this.code = code; }
}
export function fail(code) { throw new SourceIdentityError(code); }
export function assertRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  return value;
}
export function assertKeys(value, required, optional = [], code = 'source_entry_unknown_field') {
  assertRecord(value, code);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
}
export function assertSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('source_entry_size_invalid');
  return value;
}
export function assertSha256(value) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail('source_sha256_invalid');
  return value;
}
export function assertObjectFormat(value) {
  if (!['sha1', 'sha256'].includes(value)) fail('source_object_format_unsupported');
  return value;
}
export function assertObjectId(value, format) {
  assertObjectFormat(format);
  if (typeof value !== 'string' || !(format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(value)) fail('source_object_id_invalid');
  return value;
}
export function assertRepositoryPath(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed()
      || /[\\\u0000-\u001f\u007f]/u.test(value) || /^[A-Za-z]:/u.test(value)
      || /[<>:"|?*]/u.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'
        || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('source_path_invalid');
  return value;
}
export function assertSymlinkPolicy(value) {
  if (!['reject', 'internal-file'].includes(value)) fail('source_symlink_policy_unsupported');
  return value;
}
export function assertSourceEntry(entry, objectFormat = 'sha1') {
  assertRecord(entry, 'source_entry_invalid');
  assertRepositoryPath(entry.path);
  if (entry.kind === 'gitlink') {
    assertKeys(entry, ['path', 'kind', 'mode', 'objectId']);
    if (entry.mode !== '160000') fail('source_entry_mode_invalid');
    assertObjectId(entry.objectId, objectFormat);
  } else if (entry.kind === 'file' || entry.kind === 'symlink') {
    assertKeys(entry, ['path', 'kind', 'mode', 'bytes', 'sha256', ...(entry.kind === 'symlink' ? ['target'] : [])]);
    if (!(entry.kind === 'file' ? ['100644', '100755'] : ['120000']).includes(entry.mode)) fail('source_entry_mode_invalid');
    assertSize(entry.bytes); assertSha256(entry.sha256);
    if (entry.kind === 'symlink' && (typeof entry.target !== 'string' || !entry.target || !entry.target.isWellFormed())) fail('source_symlink_target_invalid');
  } else fail('source_entry_kind_unsupported');
  return entry;
}
