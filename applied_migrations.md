# Applied migrations

Additive, owner-lane (`bion_owner`) migrations. The migration runner (`pnpm migrate`)
records applied files in `schema_migrations`; this file is the human-readable record.
Never edit an applied migration — add a new one.

| Order | File | Purpose |
|------:|------|---------|
| 0001 | `migrations/0001_schema.sql` | Core data model (spec §4): messages, message_consumptions, tasks, decisions, fdqs, invariants, artifacts, agents, events. FTS `tsvector` columns + GIN. |
| 0002 | `migrations/0002_grants.sql` | Runtime permission model for `bion_rw`: append-only enforcement (inv 5), read-only meta surfaces (inv 13), column-scoped `tasks` grants excluding `ratified`. |
| 0003 | `migrations/0003_seed.sql` | Seed the 14 invariants, the FDQ-B ledger (B1/B2/B4/B5 open, B3 resolved), and the `desktop`/`kov` agent envelopes. |
| 0004 | `migrations/0004_outbox.sql` | Transactional outbox for durable side effects (Phase D1). Runtime role gets SELECT/INSERT + status-only UPDATE (payload immutable). |
| 0005 | `migrations/0005_outbox_sending.sql` | Add a pre-send `sending` state so notify is at-least-once (directive-04): claim→sending→send→done; a mid-send crash re-sends on reconcile. Publish unchanged (exactly-once). |
| 0006 | `migrations/0006_projects.sql` | Ordered project list for Auto Mode pivot-on-block (Phase E3): `projects` table (Forces-defined order) + `tasks.project`. Runtime role reads projects; may set a task's project. |
| 0007 | `migrations/0007_cost_attribution.sql` | Cost module Phase 2 (directive-18): extend `events` with `target_seat`, `trigger_class`, `model`, `tokens_in`, `tokens_out`, `est_cost`, `is_approximate` (all nullable — only cost-bearing events populate them). No new grants: cost rows are events, so append-only enforcement (inv 5) already covers them. |
| 0008 | `migrations/0008_desktop_consumption_grant.sql` | Narrow `INSERT` grant on `message_consumptions` for `bion_desktop_ro` (directive-72): lets Desktop's read-only MCP connector write the one consumption row it needs to independently consume its own mail, network-isolated from this repo's CLI. Still append-only (no `UPDATE`/`DELETE`) — additive to `bion_desktop_ro`'s existing SELECT-only footing, mirrors `bion_rw`'s existing SELECT+INSERT on the same table. **Superseded by 0009 — see below.** |
| 0009 | `migrations/0009_revoke_desktop_consumption_grant.sql` | Revert 0008 (directive-75): superseded by D-73's real fix, the `bion-desktop-mail` stdio MCP connector, which reuses `bion_rw` instead. `bion_desktop_ro` returns to SELECT-only everywhere — an unused write grant on a read-designated role is exactly the drift least-privilege exists to prevent. |
| 0011 | `migrations/0011_task_status_superseded.sql` | Add a genuine terminal `superseded` value to `tasks_status_check` (directive-126, D-125's Task 2 finding): `blocked` was overloaded for both "temporarily stuck" and "permanently dead by design" — `superseded` makes the distinction structural. Excluded from `selectAutoWork()`'s selection identically to `blocked` (already outside its `IN ('backlog','ready')` filter). |
