---
name: change-platform-runtime
description: Modify Docker, Compose, CI/CD, environment, bootstrap, build cache, observability or deployment topology.
---
# Change platform runtime
1. Identify services, ports, volumes, secrets, health checks, dependency ordering and rollback boundaries.
2. Keep host-specific paths and credentials configurable through environment or secret files.
3. Prefer reproducible pinned tool/runtime versions and persistent dependency caches.
4. Separate build-time, startup-readiness and live-runtime checks.
5. Validate failure/recovery paths, not only happy-path startup.
6. Record blocked validations explicitly when Docker, network, cloud credentials or platform tooling are unavailable.
