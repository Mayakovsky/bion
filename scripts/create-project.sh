#!/usr/bin/env bash
# create-project.sh — OWNER LANE. Insert (or reactivate) a row in `projects`.
#
# bion_rw only has SELECT on `projects` (migration 0006) — registering a project is structurally
# outside the runtime role's authority, same posture as ratification (directive-01, inv 13).
# Idempotent: re-running with a new ordinal updates it and reactivates the project.
#
# Usage: BION_MIGRATE_URL=... bash scripts/create-project.sh <id> <ordinal>
#
# NOTE on invocation shape (found while building this): on this psql build, `-v`-substituted
# variables in a `-c "..."` command are silently NOT interpolated (`:'id'` reaches the server
# literally and fails) — substitution only works reading from stdin/-f. Flags must also precede
# the connection string positional, or getopt stops parsing and everything after is "ignored" as
# extra arguments. So: flags first, conn string last, SQL via a quoted heredoc on stdin.
set -euo pipefail
PGBIN="${BION_PGBIN:-/c/Program Files/PostgreSQL/16/bin}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_ID="${1:-}"
ORDINAL="${2:-}"
[ -n "$PROJECT_ID" ] && [ -n "$ORDINAL" ] || { echo "usage: create-project.sh <id> <ordinal>" >&2; exit 2; }

# load BION_MIGRATE_URL from env or .env.local
if [ -z "${BION_MIGRATE_URL:-}" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  BION_MIGRATE_URL="$(grep -E '^BION_MIGRATE_URL=' "$REPO_ROOT/.env.local" | cut -d= -f2-)"
fi
[ -n "${BION_MIGRATE_URL:-}" ] || { echo "BION_MIGRATE_URL not set" >&2; exit 2; }

"$PGBIN/psql" -v id="$PROJECT_ID" -v ord="$ORDINAL" "$BION_MIGRATE_URL" <<'SQL'
INSERT INTO projects (id, ordinal, active) VALUES (:'id', :ord, true)
ON CONFLICT (id) DO UPDATE SET ordinal = EXCLUDED.ordinal, active = true
RETURNING id, ordinal, active;
SQL
