-- 0009_revoke_desktop_consumption_grant.sql — revert the bion_desktop_ro INSERT grant on
-- message_consumptions added by 0008 (directive-75 Task 4).
--
-- Superseded: D-73's real fix for Desktop's mail was a narrow, purpose-built stdio MCP connector
-- (src/mcp/desktopMail.ts) that runs on the real machine and reuses bion_rw — not a write grant on
-- Desktop's own read-designated connector role. D-73's own status file already flagged 0008's grant
-- as "unused by this design... landed, harmless." An unused write grant sitting on a
-- read-designated role is exactly the kind of drift least-privilege exists to prevent (the same
-- reasoning D-73's own design review cited from Anthropic's MCP guidance: deny by default, grant
-- the minimum each tier actually needs). bion_desktop_ro returns to SELECT-only everywhere,
-- matching its original, real design intent.

BEGIN;

REVOKE INSERT ON message_consumptions FROM bion_desktop_ro;

COMMIT;
