# Applied migrations

Additive, owner-lane (`bion_owner`) migrations. The migration runner (`pnpm migrate`)
records applied files in `schema_migrations`; this file is the human-readable record.
Never edit an applied migration — add a new one.

| Order | File | Purpose |
|------:|------|---------|
| 0001 | `migrations/0001_schema.sql` | Core data model (spec §4): messages, message_consumptions, tasks, decisions, fdqs, invariants, artifacts, agents, events. FTS `tsvector` columns + GIN. |
| 0002 | `migrations/0002_grants.sql` | Runtime permission model for `bion_rw`: append-only enforcement (inv 5), read-only meta surfaces (inv 13), column-scoped `tasks` grants excluding `ratified`. |
| 0003 | `migrations/0003_seed.sql` | Seed the 14 invariants, the FDQ-B ledger (B1/B2/B4/B5 open, B3 resolved), and the `desktop`/`kov` agent envelopes. |
| 0004 | `migrations/0004_outbox.sql` | Transactional outbox for durable, exactly-once side effects (Phase D1). Runtime role gets SELECT/INSERT + status-only UPDATE (payload immutable). |
