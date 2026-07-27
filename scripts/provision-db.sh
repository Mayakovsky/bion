#!/usr/bin/env bash
# provision-db.sh — stand up Bion's dedicated, isolated local Postgres cluster (spec Q1-A).
#
# Path chosen (Step 0): Docker absent, and reusing the shared :5432 server would violate the
# "dedicated/isolated" requirement — so we initdb a fresh, user-owned PG16 cluster on :5433
# from the already-installed binaries. No admin; self-contained; nothing touches the revenue plane.
#
# Idempotent: safe to re-run. Passwords are generated ONCE and persisted under ~/.bion-pg,
# then reused, so re-running never rotates a live credential.
set -euo pipefail

PGBIN="${BION_PGBIN:-/c/Program Files/PostgreSQL/16/bin}"
PGDATA="${BION_PGDATA:-$HOME/.bion-pg/data}"
PGPORT="${BION_PGPORT:-5433}"
SECRETS_DIR="$HOME/.bion-pg"
LOGFILE="$SECRETS_DIR/server.log"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$SECRETS_DIR"
gen() { node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"; }
psql_super() { PGPASSWORD="$(cat "$SECRETS_DIR/.superpw")" "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U bion_super -w "$@"; }

# 1) initdb (once)
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "[provision] initdb $PGDATA"
  [ -f "$SECRETS_DIR/.superpw" ] || gen > "$SECRETS_DIR/.superpw"
  PWFILE="$SECRETS_DIR/.superpw.tmp"; cp "$SECRETS_DIR/.superpw" "$PWFILE"
  "$PGBIN/initdb" -D "$PGDATA" -U bion_super -A scram-sha-256 --pwfile="$PWFILE" -E UTF8 --locale=C >/dev/null
  rm -f "$PWFILE"
else
  echo "[provision] cluster present at $PGDATA"
fi

# 2) start (localhost only) if not running
if ! "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -q; then
  echo "[provision] starting cluster on 127.0.0.1:$PGPORT"
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOGFILE" -o "-p $PGPORT -c listen_addresses=127.0.0.1" start
  sleep 2
fi

# 3) database
psql_super -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='bion'" | grep -q 1 \
  || "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U bion_super -w -O bion_super bion

# 4) roles (generate pw once, reuse thereafter)
[ -f "$SECRETS_DIR/.ownerpw" ] || gen > "$SECRETS_DIR/.ownerpw"
[ -f "$SECRETS_DIR/.rwpw" ]    || gen > "$SECRETS_DIR/.rwpw"
OWNERPW="$(cat "$SECRETS_DIR/.ownerpw")"; RWPW="$(cat "$SECRETS_DIR/.rwpw")"

# idempotent create + password set, per role
psql_super -d postgres -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bion_owner') THEN CREATE ROLE bion_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;
SQL
psql_super -d postgres -q <<SQL
ALTER ROLE bion_owner PASSWORD '$OWNERPW';
SQL
psql_super -d postgres -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bion_rw') THEN CREATE ROLE bion_rw LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;
SQL
psql_super -d postgres -q <<SQL
ALTER ROLE bion_rw PASSWORD '$RWPW';
SQL

# 5) db-scoped grants + ownership (runtime role must NOT own objects, so append-only REVOKE binds)
psql_super -d bion -q <<'SQL'
REVOKE ALL ON DATABASE bion FROM PUBLIC;
GRANT CONNECT ON DATABASE bion TO bion_owner, bion_rw;
ALTER SCHEMA public OWNER TO bion_owner;
REVOKE CREATE ON SCHEMA public FROM bion_rw;
GRANT USAGE ON SCHEMA public TO bion_rw;
SQL

# 6) write repo-root .env.local (gitignored)
cat > "$REPO_ROOT/.env.local" <<EOF
# Bion local env — GITIGNORED. Fresh local-dev creds; never commit or log.
BION_DATABASE_URL=postgresql://bion_rw:${RWPW}@127.0.0.1:${PGPORT}/bion
BION_MIGRATE_URL=postgresql://bion_owner:${OWNERPW}@127.0.0.1:${PGPORT}/bion
BION_NTFY_URL=
BION_NTFY_TOKEN=
EOF

echo "[provision] done. cluster 127.0.0.1:$PGPORT, db bion, roles bion_owner/bion_rw. .env.local written."
echo "[provision] next: pnpm migrate && pnpm test"
