#!/usr/bin/env bash
# ratify-project.sh — FORCES LANE. Batch-ratify every not-yet-ratified task in a project.
#
# Same posture and invariant as ratify-task.sh (directive-01 ruling 3; inv 13) — this is a
# batching convenience for Forces, not a relaxation: the runtime role still cannot touch
# `ratified` or `projects`. Bion never runs this itself.
#
# Usage: BION_MIGRATE_URL=... bash scripts/ratify-project.sh <project-id>
#
# NOTE on invocation shape: see create-project.sh — `-v` substitution silently doesn't apply
# inside a `-c "..."` command on this psql build, and flags must precede the connection string
# positional. SQL goes over stdin via a quoted heredoc instead.
set -euo pipefail
PGBIN="${BION_PGBIN:-/c/Program Files/PostgreSQL/16/bin}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_ID="${1:-}"
[ -n "$PROJECT_ID" ] || { echo "usage: ratify-project.sh <project-id>" >&2; exit 2; }

# load BION_MIGRATE_URL from env or .env.local
if [ -z "${BION_MIGRATE_URL:-}" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  BION_MIGRATE_URL="$(grep -E '^BION_MIGRATE_URL=' "$REPO_ROOT/.env.local" | cut -d= -f2-)"
fi
[ -n "${BION_MIGRATE_URL:-}" ] || { echo "BION_MIGRATE_URL not set" >&2; exit 2; }

"$PGBIN/psql" -v proj="$PROJECT_ID" "$BION_MIGRATE_URL" <<'SQL'
UPDATE tasks SET ratified = true, updated = now() WHERE project = :'proj' AND ratified = false RETURNING id, title;
SQL
