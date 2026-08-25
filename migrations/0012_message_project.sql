-- 0012_message_project.sql — add project scoping to messages (directive-146/150, FDQ-B2).
-- Lane: migration/owner (bion_owner). Additive only.
--
-- Mailbox restructure: physical packets move from a single flat .bion/mail/<recipient>/{unread,
-- read,flagged}/ into per-project subdirectories. `project` is a real, queryable column (mirrors
-- tasks.project, and this codebase's own convention of real DB columns over path-only encoding —
-- content_sha256/recipient are both real columns even though also embedded in body_path) rather
-- than only recoverable by parsing body_path strings. NULL means unscoped (the historical ~197
-- packets and any new packet sent without --project both land here — deliberately not backfilled,
-- see BION-DIRECTIVE-146-ITEM5-MAILBOX-SCOPING-PROPOSAL.md's Question 3 reasoning).

BEGIN;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS project text;
CREATE INDEX IF NOT EXISTS messages_project_idx ON messages (project);

COMMIT;
