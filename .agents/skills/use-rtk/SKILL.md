---
name: use-rtk
description: Reduce verbose shell output for Git, test, build, lint and log commands when RTK is available. Fall back immediately to the native command when RTK is unavailable or incompatible.
---

1. Check `rtk --version` at most once per session when command output is likely to be large.
2. If RTK is available, prefer `rtk <native-command>` for supported Git, test, build, lint, typecheck and log operations.
3. If RTK is unavailable or one wrapped command fails, retry that operation at most once using the original native command. Do not install or repair RTK during a task unless the Task Brief explicitly owns that work.
4. Never wrap shell builtins, generated JSON/checksum/patch output, complex pipelines, commands whose stdout is consumed by another program, or commands whose exact raw output is acceptance evidence.
5. Preserve the wrapped command's exit code and always report the underlying native command in Handoff Result validation evidence.
6. `rtk` reduces context usage; it never replaces acceptance criteria, TDD, systematic debugging, or verification-before-completion.
7. On Windows, prefer executable commands (`npm.cmd`, `git`, `node`, etc.) that do not depend on PowerShell execution policy. Do not repeatedly force unsupported commands through RTK.
