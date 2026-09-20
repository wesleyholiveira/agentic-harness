#!/usr/bin/env node
import { verifyGitManifest, snapshotGitSource } from '../src/git-snapshot.mjs';

try {
  const args = process.argv.slice(2); const options = {}; let root = null; let snapshotOnly = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error('source_cli_argument_invalid');
    seen.add(arg);
    if (arg === '--snapshot') { snapshotOnly = true; continue; }
    if (!['--root', '--commit'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('source_cli_argument_invalid');
    if (arg === '--root') root = args[++i]; else options.commit = args[++i];
  }
  if (!root) throw new Error('source_cli_root_required');
  const output = snapshotOnly
    ? snapshotGitSource(root, options)
    : { proofKind: 'legacy-manifest-source-integrity', integrity: verifyGitManifest(root, options), qualificationVerdict: null };
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  // No raw Git stderr, environment, manifest content, or credential values.
  const code = typeof error?.message === 'string' && /^source_[a-z0-9_:]+$/u.test(error.message) ? error.message : 'source_verification_failed';
  console.error(JSON.stringify({ ok: false, code, qualificationVerdict: null }));
  process.exitCode = 1;
}
