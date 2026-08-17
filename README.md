# Bion

A thin, owned **TypeScript coordinator** for a multi-agent workflow (Desktop as architect, Kov as
implementer). Bion separates **reasoning** (agents) from **coordination + state** (Bion): it owns
project state, task routing, agent messaging, and comms over rails it runs itself — Postgres
(relational state + full-text search) and disk + git (the artifact corpus, plus a file-based
mailbox).

Bion does **relational state + FTS only**. It grows no retrieval engine; semantic/vector/graph
memory lives elsewhere.

## Design

- **State store** — a dedicated, isolated local Postgres. Two roles: `bion_owner` (schema/
  migration lane) and `bion_rw` (least-privilege runtime), plus a narrow, read-only
  `bion_desktop_ro` role for Desktop's own MCP connector. Append-only tables (`messages`,
  `events`, `message_consumptions`) have `UPDATE`/`DELETE` revoked from the runtime role —
  append-only is *enforced*, not asserted.
- **Coordination primitives** — `record()` (ledger write), `send()` (routed message),
  `query_state()` (Postgres FTS + disk grep), `handoff()` (summarize state for the next agent).
- **Mailbox + Comms Protocol v1** — a real disk mailbox
  (`.bion/mail/<agent>/{unread,read,flagged}/`), atomic stage-then-rename writes, with the DB as
  routing authority (an agent acts only on a packet whose `content_sha256` matches an unconsumed
  row). Messages are pointers, not payloads — `intent`/`refs`/`fields`/an optional terse `note`,
  never prose. The reserved `escalate` intent fires a durable, at-least-once notification the
  moment a packet crosses a standing project gate (real money, mainnet, third-party accounts, the
  auto-mode env vars, credential exposure). `bion mail send`/`bion mail poll` is the CLI over it;
  `src/mcp/desktopMail.ts` is a narrow stdio MCP server exposing the same two operations for
  Desktop's own sandboxed environment, which can't reach the DB directly.
- **Idempotency** — every message and event carries a `dedup_key`; re-delivery is a no-op.
- **Daemon + watchers** — a persistent local daemon (`bion daemon`) ticks a dispatch loop,
  auto-discovers every git repo under the dev root (`.bionignore`-aware) for commit/test-result
  signals, and reacts per `BION_REACTIVE_DISPATCH` mode (`off`/`shadow`/`on`) — bounded,
  ratified-backlog-only auto-dispatch, never open-ended.
- **Auto Mode** — a shadow-gated, usage-bounded auto-work loop (`BION_AUTO_MODE`) for Kov's own
  idle cycles; off/shadow by default, every gated action still stops at Forces.
- **Cost tracking** — `bion cost` attributes tokens/estimated spend per agent seat from
  git-commit and message-send signals.
- **Tasks** — `bion task` (create/list) over a ratified-backlog model; `ratified` is owner/
  Forces-lane only, structurally unreachable from the runtime role's own grants.

## Local setup

Requires Node ≥ 20, pnpm, and a local PostgreSQL 16 install (client + server binaries).

```bash
pnpm install
pnpm db:provision   # initdb an isolated cluster on 127.0.0.1:5433, create db + roles, write .env.local
pnpm migrate        # apply migrations (owner lane)
pnpm test           # vitest run
```

`pnpm db:start` / `pnpm db:stop` control the cluster. The cluster's data dir lives outside the
repo (`~/.bion-pg`). `.env.local`/`.env.test` hold local-dev credentials and are gitignored.

Day-to-day CLIs (`tsx src/cli/*.ts`, wired as `pnpm` scripts): `status`, `task`, `mail`, `cost`,
`auto-report`, `check-heartbeat`. `pnpm daemon` runs the persistent loop; `pnpm mcp:desktop-mail`
runs the standalone mail MCP server.

## Layout

```
migrations/      additive SQL (owner lane); tracked in applied_migrations.md
scripts/         cluster provisioning + lifecycle; ratify-task.sh / ratify-project.sh (owner/Forces lane)
src/adapters/    KovAdapter/DesktopAdapter — mailbox dispatch + poll, DB-as-routing-authority
src/auto/        Auto Mode: usage checks, shadow-gated auto-work selection
src/cli/         status, task, mail, cost, auto-report, checkHeartbeat entry points
src/comms/       Comms Protocol v1 — pointer()/serialize()/parse()/validate()
src/core/        coordination primitives + data-model types + DAG enforcement
src/cost/        per-agent-seat cost attribution (git-commit + message-send signals)
src/daemon/      persistent loop, cluster autostart, single-instance lock, heartbeat
src/db/          connection pool + migration runner + transactional outbox
src/loop/        dispatcher, reactive mode, coordinator, completion reporting
src/mailbox/     disk mailbox — atomic stage-then-rename packet writes
src/mcp/         bion-desktop-mail — narrow stdio MCP server wrapping send/poll mail
src/notify/      ntfy.sh push notifications (dry-run when unconfigured)
src/watchers/    dev-root-wide git + test-result discovery and polling
test/            gate specs — round-trip, dedup, append-only, DAG, isolation, ledgers, ...
```
