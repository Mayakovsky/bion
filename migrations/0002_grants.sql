-- 0002_grants.sql — runtime permission model for bion_rw (design spec §6 inv 5 & 13, §7).
-- Lane: migration/owner (bion_owner owns the tables; bion_rw does NOT — so REVOKE binds).
--
-- Principle: bion_rw owns everything up to producing a reviewable artifact; the irreversible
-- acts (append-only mutation, envelope edits, ratification) are structurally impossible for it.

BEGIN;

-- Append-only tables: SELECT + INSERT only. UPDATE/DELETE are NEVER granted (inv 5),
-- and explicitly revoked as defense-in-depth.
GRANT SELECT, INSERT ON messages, events, message_consumptions TO bion_rw;
REVOKE UPDATE, DELETE ON messages, events, message_consumptions FROM bion_rw;

-- Ledgers Bion records into (append-mostly): record() writes; no in-place mutation.
GRANT SELECT, INSERT ON decisions, artifacts TO bion_rw;

-- FDQ ledger: Bion is its home — open (INSERT) and resolve (UPDATE) allowed.
GRANT SELECT, INSERT, UPDATE ON fdqs TO bion_rw;

-- Meta-permission surfaces are READ-ONLY to the runtime role (inv 13):
-- Bion reads the invariant set and agent envelopes to ENFORCE them, but never
-- creates an agent or edits any permission envelope. Those are owner/Forces lane.
GRANT SELECT ON agents, invariants TO bion_rw;

-- tasks: mutable, EXCEPT `ratified`. Column-scoped grants omit `ratified`, so bion_rw
-- physically cannot set it on INSERT or UPDATE (directive-01 ruling 3 / inv 13).
-- Flipping ratified true is the owner/Forces lane (scripts/ratify-task.sh).
GRANT SELECT ON tasks TO bion_rw;
GRANT INSERT (id, title, description, owner, priority, status, dependencies, created, updated)
  ON tasks TO bion_rw;
GRANT UPDATE (title, description, owner, priority, status, dependencies, updated)
  ON tasks TO bion_rw;

COMMIT;
