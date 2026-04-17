#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_CONTAINER="${P0_TEST_DB_CONTAINER:-p13-test-pg}"
DB_PORT="${P0_TEST_DB_PORT:-55432}"
DB_USER="${P0_TEST_DB_USER:-forest}"
DB_PASSWORD="${P0_TEST_DB_PASSWORD:-forest}"
DB_NAME="${P0_TEST_DB_NAME:-forest}"
DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"

cleanup() {
  docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[p0-auth-suite] starting temporary postgres (${DB_CONTAINER}) on port ${DB_PORT}..."
docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
docker run -d \
  --name "${DB_CONTAINER}" \
  -e POSTGRES_USER="${DB_USER}" \
  -e POSTGRES_PASSWORD="${DB_PASSWORD}" \
  -e POSTGRES_DB="${DB_NAME}" \
  -p "${DB_PORT}:5432" \
  postgres:16-alpine >/dev/null

echo "[p0-auth-suite] waiting for postgres readiness..."
for _ in $(seq 1 30); do
  if docker exec "${DB_CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ ! -d "${ROOT_DIR}/docker/db-migrate/node_modules" ]]; then
  echo "[p0-auth-suite] installing db-migrate dependencies..."
  npm --prefix "${ROOT_DIR}/docker/db-migrate" install >/dev/null
fi

echo "[p0-auth-suite] applying migrations..."
(
  cd "${ROOT_DIR}"
  DATABASE_URL="${DATABASE_URL}" node docker/db-migrate/migrate.mjs
)

echo "[p0-auth-suite] running typecheck..."
npm --prefix "${ROOT_DIR}/server" run typecheck

echo "[p0-auth-suite] running auth/qr integration tests..."
DATABASE_URL="${DATABASE_URL}" npm --prefix "${ROOT_DIR}/server" run test -- src/routes/auth.test.ts src/routes/auth-qr-routes.test.ts src/routes/chats-favorites.test.ts

echo "[p0-auth-suite] done."
