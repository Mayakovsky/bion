-- 0007_cost_attribution.sql — cost module Phase 2 (directive-18): attribute token/dollar cost
-- to the event that (would) cause an agent turn (build plan §"Cost attribution on events").
-- Lane: migration/owner. Additive.
--
-- Extends `events` rather than a new table: cost rows ARE events (kind='cost.kov'/'cost.desktop'),
-- so they inherit append-only enforcement + dedup_key idempotency already granted/enforced in
-- 0001/0002 — no new grants needed. Columns are nullable; only cost-bearing events populate them.

BEGIN;

ALTER TABLE events ADD COLUMN IF NOT EXISTS target_seat text CHECK (target_seat IN ('kov','desktop'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS trigger_class text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS model text;
-- int4, not int8: per-event token counts, nowhere near the range where that matters, and it
-- keeps the pg driver returning a plain JS number instead of the string int8 forces on it.
ALTER TABLE events ADD COLUMN IF NOT EXISTS tokens_in integer;
ALTER TABLE events ADD COLUMN IF NOT EXISTS tokens_out integer;
ALTER TABLE events ADD COLUMN IF NOT EXISTS est_cost numeric(12,6);
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_approximate boolean;

-- Reporting index (bion cost, Section B): burden by seat over a time window.
CREATE INDEX IF NOT EXISTS events_cost_seat_ts_idx ON events (target_seat, ts) WHERE target_seat IS NOT NULL;

COMMIT;
