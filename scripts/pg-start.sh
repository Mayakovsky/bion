#!/usr/bin/env bash
# Start the Bion cluster on 127.0.0.1:5433 (localhost only). Idempotent.
set -euo pipefail
PGBIN="${BION_PGBIN:-/c/Program Files/PostgreSQL/16/bin}"
PGDATA="${BION_PGDATA:-$HOME/.bion-pg/data}"
PGPORT="${BION_PGPORT:-5433}"
LOGFILE="$HOME/.bion-pg/server.log"

if "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q; then
  echo "[pg-start] already running on 127.0.0.1:$PGPORT"
else
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOGFILE" -o "-p $PGPORT -c listen_addresses=127.0.0.1" start
  echo "[pg-start] started on 127.0.0.1:$PGPORT"
fi
