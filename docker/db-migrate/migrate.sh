#!/bin/sh
# If POSTGRES_PASSWORD_FILE is set (Docker secrets), rebuild DATABASE_URL with the secret
if [ -f "${POSTGRES_PASSWORD_FILE:-}" ]; then
  PG_PASS=$(cat "$POSTGRES_PASSWORD_FILE")
  PG_USER="${POSTGRES_USER:-forest}"
  PG_DB="${POSTGRES_DB:-forest}"
  export DATABASE_URL="postgres://${PG_USER}:${PG_PASS}@db:5432/${PG_DB}"
  echo "[db-migrate] Using DATABASE_URL from Docker secret"
fi

echo "[db-migrate] Running drizzle-kit migrate..."
node ./node_modules/drizzle-kit/bin.cjs migrate --config drizzle.config.ts || true
echo "[db-migrate] Done."
exit 0
