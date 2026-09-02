---
name: prepare-release
description: Prepare a reproducible release of the harness or a consuming project with manifests and checksums.
---
# Prepare release
1. Freeze the intended source revision and ensure the worktree has no unexplained changes.
2. Run project-defined test/type/build/docs gates.
3. Build artifacts from source rather than packaging transient runtime state.
4. Exclude secrets, caches, `.runtime`, node_modules, virtualenvs and local credentials.
5. Generate a file manifest and SHA-256 checksum for distributable archives.
6. Record tool/runtime versions and any validation that could not be executed.
