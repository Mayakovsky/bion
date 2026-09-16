# Applied migrations

Additive, owner-lane (`bion_owner`) migrations. The migration runner (`pnpm migrate`)
records applied files in `schema_migrations`; this file is the human-readable record.
Never edit an applied migration — add a new one.

| Order | File | Purpose |
|------:|------|---------|
| 0001 | `migrations/0001_schema.sql` | Core data model: messages, message_consumptions, tasks, decisions, fdqs, invariants, artifacts, agents, events. FTS `tsvector` columns + GIN. |
| 0002 | `migrations/0002_grants.sql` | Runtime permission model for `bion_rw`: append-only enforcement (inv 5), read-only meta surfaces (inv 13), column-scoped `tasks` grants excluding `ratified`. |
| 0003 | `migrations/0003_seed.sql` | Seed the 14 invariants, the open-questions ledger (mostly open, one resolved), and the `desktop`/`kov` agent envelopes. |
| 0004 | `migrations/0004_outbox.sql` | Transactional outbox for durable side effects. Runtime role gets SELECT/INSERT + status-only UPDATE (payload immutable). |
| 0005 | `migrations/0005_outbox_sending.sql` | Add a pre-send `sending` state so notify is at-least-once: claim→sending→send→done; a mid-send crash re-sends on reconcile. Publish unchanged (exactly-once). |
| 0006 | `migrations/0006_projects.sql` | Ordered project list for Auto Mode's pivot-on-block: `projects` table (Forces-defined order) + `tasks.project`. Runtime role reads projects; may set a task's project. |
| 0007 | `migrations/0007_cost_attribution.sql` | Cost attribution: extend `events` with `target_seat`, `trigger_class`, `model`, `tokens_in`, `tokens_out`, `est_cost`, `is_approximate` (all nullable — only cost-bearing events populate them). No new grants: cost rows are events, so append-only enforcement already covers them. |
| 0008 | `migrations/0008_desktop_consumption_grant.sql` | Narrow `INSERT` grant on `message_consumptions` for `bion_desktop_ro`: lets Desktop's read-only MCP connector write the one consumption row it needs to independently consume its own mail, network-isolated from this repo's CLI. Still append-only (no `UPDATE`/`DELETE`) — additive to `bion_desktop_ro`'s existing SELECT-only footing, mirrors `bion_rw`'s existing SELECT+INSERT on the same table. **Superseded by 0009 — see below.** |
| 0009 | `migrations/0009_revoke_desktop_consumption_grant.sql` | Revert 0008: superseded by the real fix, the `bion-desktop-mail` stdio MCP connector, which reuses `bion_rw` instead. `bion_desktop_ro` returns to SELECT-only everywhere — an unused write grant on a read-designated role is exactly the drift least-privilege exists to prevent. |
| 0011 | `migrations/0011_task_status_superseded.sql` | Add a genuine terminal `superseded` value to `tasks_status_check`: `blocked` was overloaded for both "temporarily stuck" and "permanently dead by design" — `superseded` makes the distinction structural. Excluded from `selectAutoWork()`'s selection identically to `blocked` (already outside its `IN ('backlog','ready')` filter). |
