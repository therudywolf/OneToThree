#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_CONTAINER="${STAGE_TEST_DB_CONTAINER:-p13-stage-test-pg}"
DB_PORT="${STAGE_TEST_DB_PORT:-55432}"
DB_USER="${STAGE_TEST_DB_USER:-forest}"
DB_PASSWORD="${STAGE_TEST_DB_PASSWORD:-forest}"
DB_NAME="${STAGE_TEST_DB_NAME:-forest}"
DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"

cleanup() {
  docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[stage-all] starting temporary postgres (${DB_CONTAINER}) on port ${DB_PORT}..."
docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
docker run -d \
  --name "${DB_CONTAINER}" \
  -e POSTGRES_USER="${DB_USER}" \
  -e POSTGRES_PASSWORD="${DB_PASSWORD}" \
  -e POSTGRES_DB="${DB_NAME}" \
  -p "${DB_PORT}:5432" \
  postgres:16-alpine >/dev/null

echo "[stage-all] waiting for postgres readiness..."
for _ in $(seq 1 45); do
  if docker exec "${DB_CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ ! -d "${ROOT_DIR}/docker/db-migrate/node_modules" ]]; then
  echo "[stage-all] installing db-migrate dependencies..."
  npm --prefix "${ROOT_DIR}/docker/db-migrate" install >/dev/null
fi

echo "[stage-all] applying migrations..."
(
  cd "${ROOT_DIR}"
  DATABASE_URL="${DATABASE_URL}" node docker/db-migrate/migrate.mjs
)

echo "[stage-all] server typecheck..."
npm --prefix "${ROOT_DIR}/server" run typecheck

echo "[stage-all] client typecheck..."
npm --prefix "${ROOT_DIR}/client" run typecheck

echo "[stage-all] server tests (stages 0-3 coverage)..."
DATABASE_URL="${DATABASE_URL}" npm --prefix "${ROOT_DIR}/server" run test -- \
  src/app-security.test.ts \
  src/lib/crypto.test.ts \
  src/lib/http-fetch-headers.test.ts \
  src/lib/qr-link-store.test.ts \
  src/lib/session-cookie.test.ts \
  src/lib/zod-uuid.test.ts \
  src/routes/auth.test.ts \
  src/routes/auth-qr-routes.test.ts \
  src/routes/devices-link.test.ts \
  src/routes/messages-flow.test.ts \
  src/routes/chats-favorites.test.ts \
  src/routes/users-avatar-routes.test.ts

echo "[stage-all] client unit tests..."
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" -ge 20 ]]; then
  npm --prefix "${ROOT_DIR}/client" run test:unit
else
  echo "[stage-all] host Node is ${NODE_MAJOR}, running client unit tests in container..."
  if docker image inspect forestmessenger-api >/dev/null 2>&1; then
    docker run --rm --user 0:0 \
      -v "${ROOT_DIR}:/work" \
      -w /work \
      forestmessenger-api \
      sh -lc "NODE_ENV=development npm --prefix client ci --no-audit --no-fund && npm --prefix client run test:unit"
  else
    docker run --rm \
      -v "${ROOT_DIR}:/work" \
      -w /work/client \
      node:20-alpine \
      sh -lc "NODE_ENV=development npm ci --no-audit --no-fund && npm run test:unit"
  fi
fi

echo "[stage-all] docker install smoke..."
(
  cd "${ROOT_DIR}"
  ./start.sh install
)

echo "[stage-all] docker health check..."
docker compose --env-file "${ROOT_DIR}/.env.prod" -f "${ROOT_DIR}/docker-compose.prod.yml" ps

echo "[stage-all] done."
