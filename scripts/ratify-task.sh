#!/usr/bin/env bash
# ratify-task.sh — FORCES LANE. Flip tasks.ratified = true for a task id.
#
# This is intentionally OUTSIDE Bion's runtime authority: bion_rw lacks the column privilege,
# so ratifying a task (defining the auto-wake dispatch envelope) requires the owner lane
# (BION_MIGRATE_URL / bion_owner). Bion never runs this itself (inv 13; directive-01 ruling 3).
#
# Usage: BION_MIGRATE_URL=... bash scripts/ratify-task.sh <task-id>
#
# NOTE (fixed alongside directive-19): on this psql build, `-v`-substituted variables in a
# `-c "..."` command are silently NOT interpolated (`:'id'` reached the server literally and
# errored) — substitution only works reading from stdin/-f. The connection string must also come
# AFTER the flags, or getopt stops parsing there and everything after is "ignored" as an extra
# argument (this script previously put it first — untested via this path, since test/helpers.ts's
# ratifyAsForces calls the SQL directly rather than shelling out, so the break went unnoticed).
set -euo pipefail
PGBIN="${BION_PGBIN:-/c/Program Files/PostgreSQL/16/bin}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TASK_ID="${1:-}"
[ -n "$TASK_ID" ] || { echo "usage: ratify-task.sh <task-id>" >&2; exit 2; }

# load BION_MIGRATE_URL from env or .env.local
if [ -z "${BION_MIGRATE_URL:-}" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  BION_MIGRATE_URL="$(grep -E '^BION_MIGRATE_URL=' "$REPO_ROOT/.env.local" | cut -d= -f2-)"
fi
[ -n "${BION_MIGRATE_URL:-}" ] || { echo "BION_MIGRATE_URL not set" >&2; exit 2; }

"$PGBIN/psql" -v id="$TASK_ID" "$BION_MIGRATE_URL" <<'SQL'
UPDATE tasks SET ratified = true, updated = now() WHERE id = :'id' RETURNING id, title, ratified;
SQL
