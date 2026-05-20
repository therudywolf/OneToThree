#!/usr/bin/env bash
# Production deploy wrapper for ~/sites/onetothree.ru on forestserver.
#
# Usage:
#   ./deploy.sh                 # git pull + rebuild api+web
#   ./deploy.sh full            # also rebuild every other service
#   ./deploy.sh --skip-pull     # rebuild from the current checkout
#
# Bakes APP_VERSION (from ./VERSION), GIT_SHA (short HEAD), and BUILT_AT
# (UTC ISO-8601) into the api image as build args so GET /version is
# always accurate without a separate release process.
#
# Run from the project root on the server.

set -euo pipefail

cd "$(dirname "$0")"

MODE="api-web"
SKIP_PULL=0
for arg in "$@"; do
  case "$arg" in
    full) MODE="full" ;;
    --skip-pull) SKIP_PULL=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[0;34m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
die() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f docker-compose.prod.yml ]] || die "docker-compose.prod.yml not found — run from project root"

if (( SKIP_PULL == 0 )); then
  log "git fetch + fast-forward main"
  git fetch origin
  git reset --hard origin/main
fi

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
  docker compose -f docker-compose.prod.yml up -d --build
else
  log "rebuilding api + web"
  docker compose -f docker-compose.prod.yml up -d --build api web
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

ok "deploy complete"
