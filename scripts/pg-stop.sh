#!/usr/bin/env bash
# Stop the Bion cluster. Idempotent.
set -euo pipefail
PGBIN="${BION_PGBIN:-/c/Program Files/PostgreSQL/16/bin}"
PGDATA="${BION_PGDATA:-$HOME/.bion-pg/data}"

if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop
  echo "[pg-stop] stopped"
else
  echo "[pg-stop] not running"
fi
