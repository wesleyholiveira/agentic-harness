# WAVE-10 target RED — stale HMAC assertion and ambiguous Cargo.lock dependency

Operator-provided validation exposed two independent failures.

## Node contract failure

`tests/contracts/runtime-regressions.test.mjs` still asserted the pre-HMAC symbol:

`capability_fingerprint(capability)`

The final WAVE-10 implementation uses:

`capability_proof(hmac_key, &capability, &fence)`

The production source was correct; the source-inspection regression assertion was stale.

Correction:
- assert `capability_proof(hmac_key, &capability, &fence)`;
- keep the other HMAC/fence contracts unchanged.

## cargo --locked failure

`cargo test --locked --manifest-path apps/runtime-worker/Cargo.toml` rejected the committed lock.

The lock already contains two HMAC packages:
- hmac 0.12.1
- hmac 0.13.0

The `agentic-harness-worker` root package dependency list incorrectly used the
ambiguous lock reference `"hmac"`. For a graph containing multiple versions,
Cargo requires the direct dependency to be disambiguated as `"hmac 0.12.1"`.

Correction:
- root Cargo.lock dependency is now `"hmac 0.12.1"`;
- add a source contract proving the direct dependency remains version-qualified;
- runtime-worker Docker image now builds with `cargo build --locked --release`
  so lock drift cannot be silently repaired by image construction.

No behavior admission, task fencing, HMAC semantics, gateway authorization,
Docker authority, Runtime retry semantics or consumer pin was weakened.

Status: RED_FIXED_PENDING_RERUN.
