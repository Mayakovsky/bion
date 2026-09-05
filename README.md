# Bion

A thin, owned **TypeScript coordinator** for a multi-agent workflow: a chat-native agent (e.g.
**Claude Desktop**) as architect, paired with a **Claude Code CLI** instance running in a terminal
as implementer. "Kov" and "Desktop" are just this deployment's own nicknames for that pairing —
swap in whatever names you want for your own CLI agent; nothing about Bion is tied to a specific
name, only to the *shape* of the pairing (one chat-native reasoning agent, one terminal-native
coding agent).

## What Bion actually is

Bion is not a third AI in the loop. It's deterministic — **no LLM inside it.** It observes,
records, routes, and notifies; it never reasons or judges. All the actual thinking still happens
in the two agents. What Bion owns is the boundary between them: project state, task routing, agent
messaging, and comms — over rails it runs itself (Postgres for relational state + full-text
search, disk + git for the artifact corpus and a file-based mailbox). Bion does **relational state
+ FTS only**; it grows no retrieval engine, and semantic/vector/graph memory is deliberately out of
scope.

## Why this setup saves tokens — and money

The default way to run a chat agent alongside a CLI coding agent is manual relay: a human
copy-pastes context back and forth between the two, re-explaining current state on every
hand-off. That either burns tokens re-deriving history each time, or drops detail because a human
summarized it from memory. Bion removes both failure modes, for a specific, structural reason:

- **Messages are pointers, not payloads.** A dispatched packet carries an `intent`, `refs` (file
  paths, commit SHAs, task ids), and a short `note` — never a prose recap. The substance lives in
  files on disk and rows in Postgres, not in either agent's context window. Neither agent spends
  tokens holding or re-transmitting the other's history; each pulls in exactly what a task needs,
  when it needs it.
- **State outlives any one session.** Tasks, decisions, FDQs, and invariants live in a real,
  queryable ledger (Postgres FTS + disk), not in chat scroll-back. A fresh session — after a crash,
  a context reset, or just picking work back up later — rehydrates from a targeted query instead of
  a full context dump or a human re-explaining from memory. That's a direct token savings on every
  resume, and it's the difference between losing a session's work and picking it back up clean.
- **The coordinator itself is free.** Bion is plain, deterministic TypeScript — routing and
  bookkeeping, no inference. You're not paying a third model to manage the other two; the
  coordination layer costs no tokens at all.
- **Each agent stays in its lane.** The chat-native agent is well suited to conversational
  reasoning, weighing trade-offs, and holding the live thread with a human. The CLI agent is well
  suited to fast, sandboxed, tool-heavy execution — real builds, tests, git operations, in its own
  environment. Forcing one agent to do both jobs in a single context is slower and burns far more
  tokens per unit of real progress than letting each specialize and exchanging only the minimal
  signal needed to keep the other moving.

**The compounding effect:** as configured today, both seats run the same current model (Claude
Sonnet) — one instance in the desktop app, one instance in the terminal. That's not "one model plus
a bigger one for backup." It's two economical instances of the same frontier model, in a tight
loop, coordinated by a layer that costs nothing to run — and the pair genuinely produces more than
either could solo in the same context: the chat agent doesn't have to context-switch into raw
tool-execution mode, and the CLI agent doesn't have to hold a long, drifting human conversation
alongside its actual work. Each does what it's actually good at, and the hand-off is cheap by
design.

## Design

- **State store** — a dedicated, isolated local Postgres. Two roles: `bion_owner` (schema/
  migration lane) and `bion_rw` (least-privilege runtime), plus a narrow, read-only
  `bion_desktop_ro` role for the desktop agent's own MCP connector. Append-only tables (`messages`,
  `events`, `message_consumptions`) have `UPDATE`/`DELETE` revoked from the runtime role —
  append-only is *enforced*, not asserted.
- **Coordination primitives** — `record()` (ledger write), `send()` (routed message),
  `query_state()` (Postgres FTS + disk grep), `handoff()` (summarize state for the next agent).
- **Mailbox + Comms Protocol v1** — a real disk mailbox
  (`.bion/mail/<agent>/{unread,read,flagged}/`, optionally scoped further to
  `.bion/mail/<agent>/<project>/{unread,read,flagged}/`), atomic stage-then-rename writes, with the
  DB as routing authority (an agent acts only on a packet whose `content_sha256` matches an
  unconsumed row). Messages are pointers, not payloads — `intent`/`refs`/`fields`/an optional terse
  `note`, never prose. The reserved `escalate` intent fires a durable, at-least-once notification
  the moment a packet crosses a standing project gate (real money, mainnet, third-party accounts,
  the auto-mode env vars, credential exposure). `bion mail send`/`bion mail poll` is the CLI over
  it; `src/mcp/desktopMail.ts` is a narrow stdio MCP server exposing the same operations for the
  desktop agent's own sandboxed environment, which can't reach the DB directly.
- **Idempotency** — every message and event carries a `dedup_key`; re-delivery is a no-op.
- **Daemon + watchers** — a persistent local daemon (`bion daemon`) ticks a dispatch loop,
  auto-discovers every git repo under the dev root (`.bionignore`-aware) for commit/test-result
  signals, and reacts per `BION_REACTIVE_DISPATCH` mode (`off`/`shadow`/`on`) — bounded,
  ratified-backlog-only auto-dispatch, never open-ended.
- **Auto Mode** — a shadow-gated, usage-bounded auto-work loop (`BION_AUTO_MODE`) for the CLI
  agent's own idle cycles; off/shadow by default, every gated action still stops at the human.
- **Cost tracking** — `bion cost` attributes tokens/estimated spend per agent seat from
  git-commit and message-send signals.
- **Tasks** — `bion task` (create/list) over a ratified-backlog model; `ratified` is owner/
  human-lane only, structurally unreachable from the runtime role's own grants.

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
scripts/         cluster provisioning + lifecycle; ratify-task.sh / ratify-project.sh (owner/human lane)
src/adapters/    the CLI-agent adapter (named KovAdapter in this deployment) + DesktopAdapter —
                 mailbox dispatch + poll, DB-as-routing-authority. Rename/fork the adapter for your
                 own CLI agent's nickname; the interface is generic.
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
