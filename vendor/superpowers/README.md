# Superpowers v5.1.0

The harness pins `obra/superpowers` at `v5.1.0`; `lock.json` is the authority for the expected upstream skill set.

This distribution already vendors the ten Superpowers skill trees recovered from the user's earlier project checkpoint. Four v5.1.0 skills were not present in any supplied source archive: `dispatching-parallel-agents`, `requesting-code-review`, `using-git-worktrees`, and `using-superpowers`.

On a networked machine, run:

```bash
node scripts/vendor-superpowers.mjs
```

The command clones the pinned tag, replaces `vendor/superpowers/skills` with the complete upstream `skills/` tree, verifies all 14 locked skill directories, copies the upstream license/readme when available, and then removes the temporary checkout. Commit the resulting vendor tree into the official harness repository so future consuming projects need no network access for the skills.

OpenCode also pins the same Superpowers plugin tag through the generated OpenCode configuration sourced from `config/opencode.template.jsonc`; the local vendored skill path has precedence as explicit harness configuration.
