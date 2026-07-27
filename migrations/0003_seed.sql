-- 0003_seed.sql — seed the invariant + FDQ ledgers and the two day-one agent envelopes.
-- Lane: migration/owner. Idempotent (ON CONFLICT DO NOTHING). Data seed, additive.

BEGIN;

-- ── invariants (design spec §6, the day-one binding set) ──────────────────────
INSERT INTO invariants (id, statement, movement, active) VALUES
  ('INV-1',  'Never writes wpv_claims, wpv_verifications, wpv_whitepapers (standing rule).', 'bion', true),
  ('INV-2',  'Holds no keys; never runs wallet-signed or banned Alchemy commands; never --reveal.', 'bion', true),
  ('INV-3',  'Never pushes, merges, or tags without authorization; never git add -A / git add .; feature-branch commits within a ratified task are delegated.', 'bion', true),
  ('INV-4',  'Never auto-deploys or spends.', 'bion', true),
  ('INV-5',  'Messages and events are append-only and immutable; UPDATE/DELETE revoked for the Bion role.', 'bion', true),
  ('INV-6',  'Human-decision events route to Forces via ntfy; Bion never self-approves a gated action.', 'bion', true),
  ('INV-7',  'Bion does relational state + FTS only; semantic/vector/graph memory is L0 (plugin-autognostic).', 'bion', true),
  ('INV-8',  'MCP failure discipline: retry 3x, then stop and report — never proceed on partial context.', 'bion', true),
  ('INV-9',  'ntfy creds via auth header, never in logs (inherits FDQ-43).', 'bion', true),
  ('INV-10', 'Full file paths in every packet; no time estimates in any Bion output.', 'bion', true),
  ('INV-11', 'Idempotency: every message and event carries a dedup_key; re-delivery of the same key is a no-op.', 'bion', true),
  ('INV-12', 'Packet authenticity: routing authority is the DB; an unmatched or forged packet cannot dispatch an agent.', 'bion', true),
  ('INV-13', 'Meta-permission is never delegated: Bion never creates an agent or alters any permission envelope, its own included.', 'bion', true),
  ('INV-14', 'Task dependencies form a DAG; the dispatcher rejects/flags cycles.', 'bion', true)
ON CONFLICT (id) DO NOTHING;

-- ── FDQ ledger (Bion FDQ-B series; spec §11) ──────────────────────────────────
INSERT INTO fdqs (id, movement, question, ruling, status, resolved) VALUES
  ('FDQ-B1', 'bion', 'Host-relocation mechanics for the future upgrade (dump/restore vs logical replication).', NULL, 'open', NULL),
  ('FDQ-B2', 'bion', 'Mailbox packet retention/compaction policy (append-only grows unbounded).', NULL, 'open', NULL),
  ('FDQ-B3', 'bion', 'Kov auto-wake envelope = tasks within a ratified movement scope?', 'Resolved: feature-branch-commit delegation granted 2026-07-26; auto-wake envelope = tasks inside a ratified movement scope (§7).', 'resolved', now()),
  ('FDQ-B4', 'bion', 'Packet authenticity at scale: is content_sha256 + DB-corroboration sufficient, or does a remote agent need real signing?', NULL, 'open', NULL),
  ('FDQ-B5', 'bion', 'Give Desktop an MCP-independent inbound (local HTTP endpoint) later, or permanently accept MCP-at-session-start?', NULL, 'open', NULL)
ON CONFLICT (id) DO NOTHING;

-- ── agents (the two day-one adapters; authority = machine-readable §7 envelope) ─
INSERT INTO agents (id, type, capabilities, wake_mode, authority) VALUES
  ('desktop', 'reasoning',
     ARRAY['architect','spec-author','review'],
     'user_initiated',
     '{"tier1":["record","send","query_state","handoff","notify"],"gated":["push","merge","tag","deploy","spend"]}'::jsonb),
  ('kov', 'reasoning',
     ARRAY['implementer','terminal','commit'],
     'auto',
     '{"tier1":["dispatch_ratified","commit_feature_branch","request_diff","run_tests","route_packet","record"],"gated":["push","merge","tag","force_push","deploy","spend"]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

COMMIT;
