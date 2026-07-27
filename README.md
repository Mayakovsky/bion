# Bion

A thin, owned **TypeScript coordinator** for a multi-agent workflow. Bion separates
**reasoning** (agents) from **coordination + state** (Bion): it owns project state, task
routing, and agent messaging over rails we already run — Postgres (relational state + full-text
search) and disk + git (the artifact corpus).

Bion does **relational state + FTS only**. It grows no retrieval engine; semantic/vector/graph
memory lives elsewhere.

## Design

- **State store** — a dedicated, isolated local Postgres. Two roles: `bion_owner` (owns the
  schema / migration lane) and `bion_rw` (least-privilege runtime). Append-only tables
  (`messages`, `events`, `message_consumptions`) have `UPDATE`/`DELETE` revoked from the runtime
  role — append-only is *enforced*, not asserted.
- **Coordination primitives** — `record()` (ledger write), `send()` (routed message),
  `query_state()` (Postgres FTS + disk grep), `handoff()` (summarize state for the next agent).
- **Idempotency** — every message and event carries a `dedup_key`; re-delivery is a no-op.
- **Routing authority is the DB** — the mailbox is payload; an agent acts only on a packet whose
  `content_sha256` matches an unconsumed row.

## Local setup

Requires Node ≥ 20, pnpm, and a local PostgreSQL 16 install (client + server binaries).

```bash
pnpm install
pnpm db:provision   # initdb an isolated cluster on 127.0.0.1:5433, create db + roles, write .env.local
pnpm migrate        # apply migrations (owner lane)
pnpm test           # vitest run
```

`pnpm db:start` / `pnpm db:stop` control the cluster. The cluster's data dir lives outside the
repo (`~/.bion-pg`). `.env.local` holds local-dev credentials and is gitignored.

## Layout

```
migrations/   additive SQL (owner lane); tracked in applied_migrations.md
scripts/      cluster provisioning + lifecycle; ratify-task.sh (owner/Forces lane)
src/core/     coordination primitives + data-model types + DAG enforcement
src/db/       connection pool + migration runner
test/         gate specs (round-trip, dedup, append-only, DAG, isolation, ledgers)
```
