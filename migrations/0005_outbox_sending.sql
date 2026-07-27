-- 0005_outbox_sending.sql — add a pre-send 'sending' state so notify is at-least-once (directive-04).
-- Lane: migration/owner. Widens the status domain; existing rows unaffected.
--
-- Notify is claimed to 'sending' BEFORE the ntfy send, then marked 'done' AFTER it completes. A
-- crash between send and mark-done leaves the row 'sending'; the reconciler re-sends it. A duplicate
-- ntfy to a human is harmless; a lost one is not — the tradeoff favors delivery. Publish is unchanged
-- (idempotent + status-independent repair) and remains exactly-once.

BEGIN;

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check CHECK (status IN ('pending','sending','done'));

COMMIT;
