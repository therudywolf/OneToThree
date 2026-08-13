#!/usr/bin/env bash
#
# Surgical production redeploy — the iterative path, WITH the build stamp.
#
# Why this exists: `startup.sh` stamps APP_VERSION into ${ROOT}/.env, but the
# command everyone actually types for a quick redeploy —
#
#   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build web api
#
# — never sets it, because `.env.prod` holds no stamp. Compose then falls back
# to `${APP_VERSION:-dev}` and bakes "dev" into BOTH halves: the api's
# APP_VERSION and the client's NEXT_PUBLIC_APP_VERSION.
#
# That is not cosmetic. client/src/lib/version-check.ts skips the comparison
# entirely when the client is "dev", so the "new build, reload" banner goes
# dead, and GET /api/version can no longer tell an operator which commit prod
# is running. This regressed twice in one day before the script existed.
#
# Migrations run first on purpose: new columns are additive, so applying them
# while the OLD api is still serving is safe, whereas restarting the api first
# would have it query columns that do not exist yet.
#
# ONE DEPLOY AT A TIME — enforced below, learned the hard way on 2026-08-13.
# Two `compose up --build` runs raced into the container-swap phase; the loser
# died with `No such container: <id>_forestmessenger-api-1` and left the api
# REMOVED AND NOT RESTARTED. Prod was down until someone noticed. It happened
# twice in one day, because a build takes ~10 minutes and nothing said "busy".
#
# Run it DETACHED so an SSH drop cannot leave an orphaned compose mid-swap:
#   setsid nohup bash scripts/deploy-prod.sh > /tmp/deploy.log 2>&1 < /dev/null &
#
# Usage:
#   scripts/deploy-prod.sh                # migrate, then rebuild web + api
#   scripts/deploy-prod.sh web            # migrate, then rebuild web only
#   SKIP_MIGRATE=1 scripts/deploy-prod.sh # rebuild only
#   FORCE=1 scripts/deploy-prod.sh        # ignore the busy checks (emergencies)
#
# Never put APP_VERSION into .env.prod: an explicit value there wins forever
# and would freeze the reported version at whatever was pinned.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Busy checks ────────────────────────────────────────────────────────────
# 1) Another run of THIS script: the lock is held for its whole lifetime and
#    released by the kernel when the process dies, so a killed deploy does not
#    wedge the next one.
LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/onetothree-deploy.lock}"
if [ "${FORCE:-0}" != "1" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[deploy] REFUSING: another deploy is already running (holder pid: $(cat "$LOCK_FILE" 2>/dev/null || echo unknown))." >&2
    echo "[deploy] Wait for it, or re-run with FORCE=1 if you are certain it is dead." >&2
    exit 1
  fi
  printf '%s\n' "$$" >&9
fi

# 2) A BARE `docker compose … up --build` for this stack, started outside this
#    script — the exact shape of both incidents. The lock cannot see those, and
#    an orphan left by a dropped SSH session outlives its parent, so match on
#    the compose file name instead of on a parent process.
if [ "${FORCE:-0}" != "1" ] && command -v pgrep >/dev/null 2>&1; then
  foreign="$(pgrep -af 'docker-compose\.prod\.yml.*up' 2>/dev/null | grep -v "^$$ " || true)"
  if [ -n "$foreign" ]; then
    echo "[deploy] REFUSING: a compose run for this stack is already in flight:" >&2
    printf '  %s\n' "$foreign" >&2
    echo "[deploy] Let it finish (a full build is ~10 min). FORCE=1 overrides." >&2
    exit 1
  fi
fi

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.prod)
SERVICES=("$@")
if [ ${#SERVICES[@]} -eq 0 ]; then
  SERVICES=(web api)
fi

APP_VERSION="$(git describe --tags --always 2>/dev/null || echo dev)"
GIT_SHA="$(git rev-parse --short=8 HEAD 2>/dev/null || echo nogit)"
BUILT_AT="$(date -u +%FT%TZ)"
export APP_VERSION GIT_SHA BUILT_AT

if [ "$APP_VERSION" = "dev" ]; then
  echo "[deploy] refusing to build: git describe produced no version (is this a git checkout?)" >&2
  exit 1
fi

echo "[deploy] stamp     : $APP_VERSION ($GIT_SHA, $BUILT_AT)"
echo "[deploy] services  : ${SERVICES[*]}"

if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  echo "[deploy] migrating database before touching the api…"
  "${COMPOSE[@]}" up --build db-migrate
fi

echo "[deploy] rebuilding ${SERVICES[*]} (the old containers keep serving until the swap)…"
"${COMPOSE[@]}" up -d --build "${SERVICES[@]}"

# Verify the stamp actually reached both halves — a silent "dev" is the exact
# failure this script exists to prevent, so do not trust the build log alone.
echo "[deploy] verifying…"
served="$(curl -sS --max-time 10 "https://api.$(grep -E '^DOMAIN=' .env.prod | cut -d= -f2- | tr -d '"')/api/version" 2>/dev/null || true)"
echo "[deploy] GET /api/version -> ${served:-<unreachable>}"
if [ -n "$served" ] && ! printf '%s' "$served" | grep -qF "$APP_VERSION"; then
  echo "[deploy] WARNING: the api reports a different version than we just built." >&2
fi

baked="$(docker exec forestmessenger-web-1 sh -c 'grep -h NEXT_PUBLIC_APP_VERSION /app/.env.production 2>/dev/null' 2>/dev/null || true)"
echo "[deploy] client bundle    -> ${baked:-<unknown>}"
if [ -n "$baked" ] && ! printf '%s' "$baked" | grep -qF "$APP_VERSION"; then
  echo "[deploy] WARNING: the client bundle was baked with a different version — the reload banner will misbehave." >&2
fi

echo "[deploy] done."
