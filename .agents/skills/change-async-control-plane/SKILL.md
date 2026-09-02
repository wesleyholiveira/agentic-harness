---
name: change-async-control-plane
description: Design or modify queues, workers, outbox/inbox, retry, DLQ, leases, fencing or asynchronous workflows.
---
# Change async control plane
1. Identify the authoritative state store, message transport and consumer ownership.
2. Define envelope/version, idempotency/effect key, ack boundary, retry policy, poison-message handling and recovery semantics before editing.
3. Prefer transactional outbox for state+publish coupling and inbox/effect keys for effectively-once consumer effects.
4. Make attempts, leases, generations and fencing explicit where process replacement is possible.
5. Test duplicate delivery, consumer crash, producer crash, broker outage, replay and recovery.
6. Preserve observable evidence for every state transition and declare residual delivery guarantees precisely.
