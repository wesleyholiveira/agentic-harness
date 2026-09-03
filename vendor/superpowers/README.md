# Superpowers v5.1.0

The harness pins `obra/superpowers` at `v5.1.0`; `lock.json` is the authority for the expected upstream skill set.

This distribution vendors the complete **14/14** locked Superpowers skill tree under `vendor/superpowers/skills`, including `dispatching-parallel-agents`, `requesting-code-review`, `using-git-worktrees`, and `using-superpowers`. Consumers therefore do not need a network fetch to resolve the skill files themselves.

To intentionally refresh or re-verify the vendor tree on a networked machine, run:

```bash
node scripts/vendor-superpowers.mjs
```

The command clones the pinned tag, replaces `vendor/superpowers/skills` with the upstream `skills/` tree, verifies all 14 locked skill directories, copies the upstream license/readme when available, and removes the temporary checkout. Commit resulting changes in the official harness repository, never in a consuming project.

OpenCode also pins the same Superpowers plugin tag through the effective configuration generated from `config/opencode.template.jsonc`; the explicit local vendor path guarantees the harness-owned skill resolution surface is present in source.
