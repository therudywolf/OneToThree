#!/bin/sh
set -e

# If POSTGRES_PASSWORD_FILE is set (Docker secrets), rebuild DATABASE_URL with the secret
if [ -f "${POSTGRES_PASSWORD_FILE:-}" ]; then
  PG_PASS=$(cat "$POSTGRES_PASSWORD_FILE")
  PG_USER="${POSTGRES_USER:-forest}"
  PG_DB="${POSTGRES_DB:-forest}"
  export DATABASE_URL="postgres://${PG_USER}:${PG_PASS}@db:5432/${PG_DB}"
  echo "[db-migrate] Using DATABASE_URL from Docker secret"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "[db-migrate] ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

# Show migration folder contents for debugging
echo "[db-migrate] Migration folder contents:"
ls -1 server/drizzle/*.sql 2>/dev/null | wc -l | xargs -I{} echo "  {} SQL migration files found"
echo "[db-migrate] Journal entries:"
grep -c '"tag"' server/drizzle/meta/_journal.json 2>/dev/null | xargs -I{} echo "  {} entries in _journal.json"

echo "[db-migrate] Running migrations via drizzle-orm..."
node ./migrate.mjs
