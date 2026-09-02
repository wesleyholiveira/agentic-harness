---
name: change-database-schema
description: Create or modify a database schema, migration, index, persisted contract or transaction boundary.
---
# Change database schema
1. Inspect the consuming project's schema/migration authority and affected queries.
2. Specify old/new shape, compatibility window, backfill, indexes, transaction semantics and rollback.
3. Make migrations idempotent where applicable and safe against partially deployed application versions.
4. Prove query/index impact with the database-native planner or focused integration tests when available.
5. Keep secrets and credentials outside committed artifacts.
6. Update ADR/Design documentation when the persistence boundary changes.
