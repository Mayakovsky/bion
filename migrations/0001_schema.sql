-- 0001_schema.sql — Bion core data model (design spec §4).
-- Lane: migration/owner (bion_owner). Additive only.
--
-- Append-only tables (messages, events, message_consumptions) carry NO mutable column;
-- lifecycle is derived from the consumption ledger + events (directive-01, ruling 2).

BEGIN;

-- ── messages ─────────────────────────────────────────────────────────────────
-- Append-only, immutable routed packets. `content_sha256` corroborates the on-disk
-- packet against this row; `dedup_key` makes re-delivery a no-op; `origin` = authoring adapter.
CREATE TABLE IF NOT EXISTS messages (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ts             timestamptz NOT NULL DEFAULT now(),
  sender         text NOT NULL,
  recipient      text NOT NULL,
  thread         text,
  type           text NOT NULL DEFAULT 'packet',
  summary        text NOT NULL DEFAULT '',
  body_path      text,
  content_sha256 text NOT NULL,
  dedup_key      text NOT NULL,
  origin         text NOT NULL,
  search_tsv     tsvector GENERATED ALWAYS AS
                   (to_tsvector('english', coalesce(summary,'') || ' ' || coalesce(thread,''))) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_dedup_key_uidx ON messages (dedup_key);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient);
CREATE INDEX IF NOT EXISTS messages_content_sha_idx ON messages (content_sha256);
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING gin (search_tsv);

-- ── message_consumptions ─────────────────────────────────────────────────────
-- Append-only consumption ledger. Keeps `messages` immutable while modelling
-- unconsumed/consumed routing state (§5). "Unconsumed" = no row here for the message.
-- UNIQUE(message_id) => a message is consumed at most once (idempotent).
CREATE TABLE IF NOT EXISTS message_consumptions (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  message_id  text NOT NULL REFERENCES messages(id),
  consumer    text NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now(),
  dedup_key   text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS message_consumptions_msg_uidx   ON message_consumptions (message_id);
CREATE UNIQUE INDEX IF NOT EXISTS message_consumptions_dedup_uidx ON message_consumptions (dedup_key);

-- ── tasks ────────────────────────────────────────────────────────────────────
-- Mutable. `dependencies[]` must form a DAG (app-enforced, inv 14).
-- `ratified` defines the auto-wake dispatch envelope (FDQ-B3); flipping it true is
-- Forces-gated (inv 13) and enforced at the credential level in 0002_grants.sql.
CREATE TABLE IF NOT EXISTS tasks (
  id           text PRIMARY KEY,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  owner        text,
  priority     int  NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'backlog'
                 CHECK (status IN ('backlog','ready','in_progress','blocked','done','failed')),
  dependencies text[] NOT NULL DEFAULT '{}',
  ratified     boolean NOT NULL DEFAULT false,
  created      timestamptz NOT NULL DEFAULT now(),
  updated      timestamptz NOT NULL DEFAULT now()
);

-- ── decisions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS decisions (
  id         text PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  decision   text NOT NULL,
  rationale  text NOT NULL DEFAULT '',
  impact     text NOT NULL DEFAULT '',
  movement   text,
  supersedes text REFERENCES decisions(id),
  search_tsv tsvector GENERATED ALWAYS AS
               (to_tsvector('english', coalesce(decision,'') || ' ' || coalesce(rationale,''))) STORED
);
CREATE INDEX IF NOT EXISTS decisions_search_idx ON decisions USING gin (search_tsv);

-- ── fdqs ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fdqs (
  id         text PRIMARY KEY,
  movement   text,
  question   text NOT NULL,
  ruling     text,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  opened     timestamptz NOT NULL DEFAULT now(),
  resolved   timestamptz,
  search_tsv tsvector GENERATED ALWAYS AS
               (to_tsvector('english', coalesce(question,'') || ' ' || coalesce(ruling,''))) STORED
);
CREATE INDEX IF NOT EXISTS fdqs_search_idx ON fdqs USING gin (search_tsv);

-- ── invariants ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invariants (
  id         text PRIMARY KEY,
  statement  text NOT NULL,
  movement   text,
  active     boolean NOT NULL DEFAULT true,
  search_tsv tsvector GENERATED ALWAYS AS
               (to_tsvector('english', coalesce(statement,''))) STORED
);
CREATE INDEX IF NOT EXISTS invariants_search_idx ON invariants USING gin (search_tsv);

-- ── artifacts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  id      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type    text NOT NULL CHECK (type IN ('doc','source','commit','diff','report')),
  ref     text NOT NULL,
  task_id text REFERENCES tasks(id)
);

-- ── agents ───────────────────────────────────────────────────────────────────
-- `authority` = machine-readable per-agent gate policy (§7). Editing it is meta-permission
-- (inv 13); the runtime role has SELECT only (0002_grants.sql).
CREATE TABLE IF NOT EXISTS agents (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}',
  wake_mode    text NOT NULL CHECK (wake_mode IN ('auto','user_initiated')),
  authority    jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ── events ───────────────────────────────────────────────────────────────────
-- Append-only. `dedup_key` makes duplicate signals a no-op (inv 11).
CREATE TABLE IF NOT EXISTS events (
  id        text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ts        timestamptz NOT NULL DEFAULT now(),
  kind      text NOT NULL,
  payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  source    text NOT NULL,
  dedup_key text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup_key_uidx ON events (dedup_key);
CREATE INDEX IF NOT EXISTS events_kind_idx ON events (kind);

COMMIT;
