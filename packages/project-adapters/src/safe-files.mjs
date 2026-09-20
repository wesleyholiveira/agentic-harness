import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from '../../harness-contracts/src/source-identity.mjs';
import { assertProjectPath } from '../../harness-contracts/src/project-descriptor.mjs';

export function projectRoot(root) {
  try { const absolute = realpathSync(resolve(root)); if (!lstatSync(absolute).isDirectory()) fail('project_root_invalid'); return absolute; }
  catch { fail('project_root_invalid'); }
}
export function checkedPath(root, path, { missing = false, lstat = lstatSync } = {}) {
  assertProjectPath(path, { root: true });
  let current = root;
  const parts = path === '.' ? [] : path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstat(current); } catch (error) { if (missing && error.code === 'ENOENT') return null; fail('project_path_unreadable'); }
    if (stat.isSymbolicLink()) fail('project_path_symlink');
    if (index < parts.length - 1 && !stat.isDirectory()) fail('project_path_not_directory');
  }
  return current;
}

/** Local snapshot guard, NOT a sandbox against a hostile concurrent filesystem. */
export function readProjectFile(root, path, { maxBytes = 262144, optional = false } = {}) {
  const absolute = checkedPath(root, path, { missing: optional });
  if (!absolute) return null;
  let fd;
  try {
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) fail('project_file_not_regular');
    if (before.size > maxBytes) fail('project_file_limit');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) fail('project_file_changed'); offset += count; }
    const after = fstatSync(fd);
    checkedPath(root, path);
    const current = lstatSync(absolute);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size || before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('project_file_changed');
    return { bytes, evidence: { path, bytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } };
  } catch (error) { if (error.code?.startsWith('project_')) throw error; fail('project_file_unreadable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Native JSON parser plus duplicate-key/depth rejection, with redacted errors. */
export function parseProjectJson(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('project_json_invalid'); }
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      stack.push({ object: c === '{', key: c === '{', seen: new Set() });
      if (stack.length > 64) fail('project_json_depth_limit');
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.at(-1)?.object) stack.at(-1).key = true;
    else if (c === ':' && stack.at(-1)?.object) stack.at(-1).key = false;
    else if (c === '"') {
      const start = i++;
      while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i] === '"') break; else i++; }
      const parent = stack.at(-1);
      if (parent?.object && parent.key) {
        let key;
        try { key = JSON.parse(text.slice(start, i + 1)); } catch { fail('project_json_invalid'); }
        if (parent.seen.has(key)) fail('project_json_duplicate_key');
        parent.seen.add(key); parent.key = false;
      }
    }
  }
  try { return JSON.parse(text); } catch { fail('project_json_invalid'); }
}
