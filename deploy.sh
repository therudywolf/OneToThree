#!/usr/bin/env bash
# Production deploy wrapper for ~/sites/onetothree.ru on the deploy host.
#
# Usage:
#   ./deploy.sh                 # test + snapshot + git pull + rebuild api+web
#   ./deploy.sh full            # also rebuild every other service
#   ./deploy.sh --skip-pull     # rebuild from the current checkout
#   ./deploy.sh --skip-tests    # skip the pre-deploy test gate (emergencies only)
#
# Before touching the running stack this wrapper:
#   1. runs the server + client test suites against an ephemeral DB/Redis and
#      ABORTS the deploy if anything fails (override with --skip-tests);
#   2. tags the current api/web images as forestmessenger-*:rollback and
#      pg_dumps the database into ./backups/ — both BEFORE migrations run.
#
# Bakes APP_VERSION (from ./VERSION), GIT_SHA (short HEAD), and BUILT_AT
# (UTC ISO-8601) into the api image as build args so GET /version is
# always accurate without a separate release process.
#
# Rollback (when a deploy misbehaves):
#   # fast — restore the previous images, no rebuild:
#   docker image tag forestmessenger-api:rollback forestmessenger-api:latest
#   docker image tag forestmessenger-web:rollback forestmessenger-web:latest
#   docker compose -f docker-compose.prod.yml up -d --no-build api web
#   # or roll the code back and redeploy:
#   git reset --hard <previous-sha> && ./deploy.sh --skip-pull
#   # undo a destructive migration from the pre-deploy snapshot:
#   gunzip -c backups/predeploy-db-<stamp>.sql.gz \
#     | docker compose -f docker-compose.prod.yml exec -T db psql -U forest -d forest
# The exact commands for the last run are printed when the deploy finishes.
#
# Run from the project root on the server.

set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.prod.yml"

# Ephemeral resources for the pre-deploy test gate. Kept at script scope so the
# EXIT trap can always tear them down, even on an aborted run.
PREDEPLOY_NET="o2t-predeploy-net"
PREDEPLOY_DB="o2t-predeploy-db"
PREDEPLOY_REDIS="o2t-predeploy-redis"
NPM_CACHE_VOLUME="o2t-predeploy-npm-cache"

DB_SNAPSHOT=""

log() { printf '\033[0;34m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
die() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Prints the leading comment block (everything between the shebang and `set`),
# so --help never drifts out of sync with the header.
usage() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
}

MODE="api-web"
SKIP_PULL=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    full) MODE="full" ;;
    --skip-pull) SKIP_PULL=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# --- pre-deploy test gate -----------------------------------------------------

cleanup_predeploy_test_env() {
  docker rm -f "$PREDEPLOY_DB" "$PREDEPLOY_REDIS" >/dev/null 2>&1 || true
  docker network rm "$PREDEPLOY_NET" >/dev/null 2>&1 || true
}

# Runs the server + client test suites against throwaway Postgres/Redis
# containers, exactly mirroring the CI `test` job. Returns the suite exit code;
# the prod database is never touched. Side effect: populates node_modules in the
# checkout (gitignored + dockerignored, so builds and `git reset` are unaffected).
run_test_suites() {
  cleanup_predeploy_test_env
  trap cleanup_predeploy_test_env EXIT

  docker network create "$PREDEPLOY_NET" >/dev/null \
    || die "could not create the ephemeral test network"
  docker run -d --rm --name "$PREDEPLOY_DB" --network "$PREDEPLOY_NET" \
    -e POSTGRES_USER=forest -e POSTGRES_PASSWORD=forest -e POSTGRES_DB=forest \
    postgres:16-alpine >/dev/null \
    || die "could not start the ephemeral test database"
  docker run -d --rm --name "$PREDEPLOY_REDIS" --network "$PREDEPLOY_NET" \
    redis:7-alpine >/dev/null \
    || die "could not start the ephemeral test redis"

  log "waiting for the ephemeral test database..."
  local ready=0 i
  for i in $(seq 1 30); do
    if docker exec "$PREDEPLOY_DB" pg_isready -U forest -d forest >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  (( ready == 1 )) || die "ephemeral test database did not become ready"

  log "running server + client test suites (npm ci + vitest — a few minutes)..."
  docker run --rm --network "$PREDEPLOY_NET" \
    -v "$PWD":/repo -w /repo \
    -v "$NPM_CACHE_VOLUME":/root/.npm \
    -e CI=1 -e HUSKY=0 \
    -e DATABASE_URL="postgres://forest:forest@${PREDEPLOY_DB}:5432/forest" \
    -e JWT_SECRET="predeploy-test-suite-jwt-secret-not-a-production-key" \
    -e REDIS_URL="redis://${PREDEPLOY_REDIS}:6379" \
    -e VITEST_REDIS_URL="redis://${PREDEPLOY_REDIS}:6379" \
    node:20-alpine \
    sh -c 'npm ci --no-audit --no-fund && npm run db:push && npm run test:server && npm run test:unit -w project-13-client'
  local rc=$?

  cleanup_predeploy_test_env
  trap - EXIT
  return $rc
}

# --- pre-migrate snapshots ----------------------------------------------------

# Tags the currently-running api/web images so a bad release can be restored
# without a rebuild. No-op on the very first deploy.
snapshot_images() {
  local svc img tagged=0
  for svc in api web; do
    img="$(docker compose -f "$COMPOSE_FILE" images -q "$svc" 2>/dev/null | head -n1)" || img=""
    if [[ -n "$img" ]]; then
      docker image tag "$img" "forestmessenger-${svc}:rollback"
      tagged=1
    fi
  done
  if (( tagged == 1 )); then
    ok "tagged current api/web images as forestmessenger-*:rollback"
  else
    log "no running api/web images to snapshot (first deploy)"
  fi
}

# pg_dumps the database into ./backups/ BEFORE migrations run, so a destructive
# migration can be undone. --clean --if-exists makes the dump restorable onto a
# live database.
snapshot_database() {
  mkdir -p backups
  DB_SNAPSHOT="backups/predeploy-db-$(date -u +%Y%m%d-%H%M%S).sql.gz"

  if ! docker compose -f "$COMPOSE_FILE" exec -T db \
       pg_isready -U "${POSTGRES_USER:-forest}" >/dev/null 2>&1; then
    log "starting the db service for the pre-migrate snapshot..."
    docker compose -f "$COMPOSE_FILE" up -d db >/dev/null 2>&1 || true
    local ready=0 i
    for i in $(seq 1 30); do
      if docker compose -f "$COMPOSE_FILE" exec -T db \
         pg_isready -U "${POSTGRES_USER:-forest}" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 1
    done
    (( ready == 1 )) || die "database not reachable for the pre-migrate pg_dump"
  fi

  local tmp="${DB_SNAPSHOT}.partial"
  if docker compose -f "$COMPOSE_FILE" exec -T db sh -c \
       'PGPASSWORD="$(cat /run/secrets/postgres_password 2>/dev/null)" pg_dump --clean --if-exists -U "${POSTGRES_USER:-forest}" -d "${POSTGRES_DB:-forest}"' \
       | gzip -c > "$tmp"; then
    mv "$tmp" "$DB_SNAPSHOT"
    ok "database snapshot: $DB_SNAPSHOT ($(du -h "$DB_SNAPSHOT" | cut -f1))"
  else
    rm -f "$tmp"
    die "pre-migrate pg_dump failed — aborting before any migration runs"
  fi

  # Keep only the 10 most recent pre-deploy snapshots.
  ls -1t backups/predeploy-db-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f || true
}

# --- main ---------------------------------------------------------------------

[[ -f "$COMPOSE_FILE" ]] || die "$COMPOSE_FILE not found — run from project root"

PREV_SHA="$(git rev-parse --short=8 HEAD 2>/dev/null || printf 'unknown')"

if (( SKIP_PULL == 0 )); then
  log "git fetch + fast-forward main"
  git fetch origin
  git reset --hard origin/main
fi

if (( SKIP_TESTS == 0 )); then
  log "── pre-deploy test gate ──"
  run_test_suites || die "test suites failed — aborting deploy (re-run with --skip-tests to bypass)"
  ok "test suites passed"
else
  log "⚠ skipping the pre-deploy test gate (--skip-tests)"
fi

log "── pre-migrate snapshots ──"
snapshot_images
snapshot_database

# stale one-shot containers (db-migrate) sometimes block recreate after
# the directory move — clean them up first.
docker rm -f forestmessenger-db-migrate-1 2>/dev/null || true

APP_VERSION="$(cat VERSION 2>/dev/null | tr -d '[:space:]')"
APP_VERSION="${APP_VERSION:-dev}"
GIT_SHA="$(git rev-parse --short=8 HEAD 2>/dev/null || printf 'nogit')"
BUILT_AT="$(date -u +%FT%TZ)"

export APP_VERSION GIT_SHA BUILT_AT

log "APP_VERSION=$APP_VERSION  GIT_SHA=$GIT_SHA  BUILT_AT=$BUILT_AT"

if [[ "$MODE" == "full" ]]; then
  log "rebuilding the entire stack"
  docker compose -f "$COMPOSE_FILE" up -d --build
else
  log "rebuilding api + web (db-migrate runs migrations as a dependency)"
  docker compose -f "$COMPOSE_FILE" up -d --build api web
fi

log "waiting for api to settle..."
for _ in $(seq 1 30); do
  if curl -sfS -o /dev/null -m 3 https://api.onetothree.ru/health; then
    ok "api up"
    break
  fi
  sleep 2
done

log "deployed version:"
curl -sS https://api.onetothree.ru/version || die "version probe failed"
printf '\n'

log "── rollback for this deploy, if needed ──"
cat <<ROLLBACK
  previous commit : ${PREV_SHA}
  image snapshot  : forestmessenger-api:rollback , forestmessenger-web:rollback
  db snapshot     : ${DB_SNAPSHOT:-<none>}

  # fast image rollback (no rebuild):
  docker image tag forestmessenger-api:rollback forestmessenger-api:latest
  docker image tag forestmessenger-web:rollback forestmessenger-web:latest
  docker compose -f ${COMPOSE_FILE} up -d --no-build api web

  # code rollback:
  git reset --hard ${PREV_SHA} && ./deploy.sh --skip-pull

  # restore the database (only if a migration must be undone):
  gunzip -c ${DB_SNAPSHOT:-backups/predeploy-db-<stamp>.sql.gz} \\
    | docker compose -f ${COMPOSE_FILE} exec -T db psql -U forest -d forest
ROLLBACK

ok "deploy complete"
