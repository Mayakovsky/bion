-- 0004_outbox.sql — transactional outbox for durable, exactly-once side effects (Phase D1).
-- Lane: migration/owner. Additive.
--
-- Every committed intent (publish a packet, send a notification) is written to this table in the
-- SAME transaction as its state row. A drainer/reconciler performs the side effect and marks the
-- entry done — idempotently. Closes FDQ-B7 (crash between event-record and outward action) and the
-- rename-window (row committed but file never published).

BEGIN;

CREATE TABLE IF NOT EXISTS outbox (
  id        text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind      text NOT NULL CHECK (kind IN ('publish','notify')),
  payload   jsonb NOT NULL,                 -- durable body / notification target; immutable
  status    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  dedup_key text NOT NULL,                  -- idempotency: re-enqueue is a no-op
  attempts  int  NOT NULL DEFAULT 0,
  created   timestamptz NOT NULL DEFAULT now(),
  done_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedup_key_uidx ON outbox (dedup_key);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (created) WHERE status = 'pending';

-- Runtime grants: append + read + status-only mutation. payload/kind/dedup_key are immutable to
-- the runtime role (column-scoped UPDATE), so the durable intent cannot be rewritten (cf. inv 5).
GRANT SELECT, INSERT ON outbox TO bion_rw;
GRANT UPDATE (status, done_at, attempts) ON outbox TO bion_rw;

COMMIT;
