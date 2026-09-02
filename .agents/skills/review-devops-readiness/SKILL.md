---
name: review-devops-readiness
description: Use during infrastructure review and operational readiness to assess provider feasibility, IaC, FinOps, security, scalability, observability, recovery and release operability. Do not use as a substitute for application architecture or local platform implementation.
---

# Review DevOps Readiness

1. Consume the exact PRD and architecture revision.
2. Quantify workload, capacity, regions, availability, RPO/RTO and budget assumptions.
3. Compare at least two viable deployment/provider options when the decision is not already constrained.
4. Define IaC ownership, environments, networking, IAM, secrets, backups, observability, scaling and rollback.
5. Add operational acceptance criteria to the story/task package.
6. At readiness, verify executable evidence rather than design prose.
7. Return `approved`, `changes_requested` or `blocked` with costs, risks and required deltas.
