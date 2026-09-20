# Foundation contracts — initial T01 slice

`src/source-identity.mjs` provides strict source-record/path/version contracts.
`src/docker-runner.mjs` provides strict resolved Docker/Compose runner validation,
a deterministic identity digest and consistency assessment of supplied evidence.

Docker runner identity binds context + daemon, ordered Compose files, profiles,
project, service, purpose, operation/replica, image ID, source/config/mount/lock
digests, platform, user and container cwd. No host compiler fallback exists.
Validation scope is a separate caller-authorized input, not inferred from Docker.

Evidence phases are declared, materialized, toolchain and behavior. Missing proof
is HOLD; failed commands stay FAIL; contradictory receipts are rejected. Complete
consistent data returns CONTRACT_SATISFIED, never a qualification PASS.
`trustVerified=false` and `qualificationVerdict=null` are intentional: this module
neither executes probes nor authenticates their issuer. The future authorized
runner/receipt layer must do both. Supplied digests are not magic proof of execution.

This first runner contract supports POSIX container paths and Docker/Compose. It
is not a completed portable runner adapter; native/Windows-container adapters,
real probe collection, secret-version references, policy admission, GPU and live
readiness are still pending in T03/T04/T10/T11/T13. Build/test/runtime purposes are
explicit but their artifact relationship must be established by those tasks.

No active Runtime schema, retry policy, cache configuration, namespace, database
or model routing is changed by these modules.
