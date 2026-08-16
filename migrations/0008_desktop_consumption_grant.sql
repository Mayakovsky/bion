-- 0008_desktop_consumption_grant.sql — narrow INSERT grant on message_consumptions for
-- bion_desktop_ro (directive-72).
--
-- Why: D-71 proved a real send (Kov -> Desktop) but Desktop's sandbox can only reach the DB
-- through its own read-only MCP connector (bion_desktop_ro), not through this repo's CLI against
-- the real cluster (network-isolated, not a code gap). Desktop needs to independently consume its
-- own mail: hash the file, match it via SQL, insert the one consumption row pollStatus() would
-- have written, then move the file to read/ itself. Everything else about that connector's
-- boundary is unchanged — this is additive, one column-scoped table, nothing else.
--
-- message_consumptions is still an append-only ledger by original design (directive-01, decision
-- 2): bion_rw already has SELECT+INSERT (no UPDATE/DELETE, migrations/0002_grants.sql) on it.
-- This grant puts bion_desktop_ro on the same append-only footing for this one table, not a
-- departure from that design.
--
-- Note: bion_desktop_ro's own CREATE ROLE / initial SELECT grants are NOT tracked by any
-- migration in this repo (predates the migration-file convention for this role — confirmed via a
-- live pre-grant check, not assumed). That gap is pre-existing and out of this directive's scope;
-- this migration only adds the one new grant this directive authorizes.

BEGIN;

GRANT INSERT ON message_consumptions TO bion_desktop_ro;

COMMIT;
