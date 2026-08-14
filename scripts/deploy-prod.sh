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
  # `>` is O_TRUNC and the truncation happens at OPEN — before flock ever runs.
  # So the run that LOSES the race read back a file it had just emptied itself,
  # `holder` was unconditionally blank, and the refusal below could only ever
  # say "unknown"; it also destroyed the winner's recorded pid, which is what
  # the next line tells the operator to go and check. Open O_APPEND for the
  # lock, and rewrite the pid only once the lock is actually ours.
  exec 9>>"$LOCK_FILE"
  if ! flock -n 9; then
    holder="$(tr -d '\r\n' < "$LOCK_FILE" 2>/dev/null || true)"
    echo "[deploy] REFUSING: another deploy is already running (holder pid: ${holder:-unknown})." >&2
    echo "[deploy] Wait for it, or re-run with FORCE=1 if you are certain it is dead." >&2
    exit 1
  fi
  : >"$LOCK_FILE"
  printf '%s\n' "$$" >&9
fi

# 2) A BARE `docker compose … up --build` for this stack, started outside this
#    script — the exact shape of both incidents. The lock cannot see those, and
#    an orphan left by a dropped SSH session outlives its parent, so match on
#    the compose file name instead of on a parent process.
#
#    The pattern must anchor on the docker BINARY (`docker compose …` or the
#    `…/cli-plugins/docker-compose compose …` child). Matching the compose file
#    name anywhere in a command line also flags every shell, editor or ssh
#    invocation that merely mentions it — a false refusal teaches people to
#    reach for FORCE=1, which is exactly the habit this guard exists to prevent.
if [ "${FORCE:-0}" != "1" ] && command -v pgrep >/dev/null 2>&1; then
  foreign="$(pgrep -af '(^|/)docker(-compose)? +(compose +)?.*-f +[^ ]*docker-compose\.prod\.yml.* up' 2>/dev/null | grep -v "^$$ " || true)"
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

# One formula for every deploy path. This script used to stamp
# `git describe --tags --always` while deploy.sh stamped ./VERSION and
# startup.sh stamped nothing that reached Compose at all — and because all three
# do partial rebuilds, the api and the web half of a single deployment regularly
# ended up with stamps that could never compare equal. See scripts/lib/build-stamp.sh.
# shellcheck source=lib/build-stamp.sh
. "$ROOT/scripts/lib/build-stamp.sh"

if ! build_stamp_export "$ROOT"; then
  echo "[deploy] refusing to build: no ./VERSION, or this is not a git checkout — the stamp would be \"dev\", and version-check.ts skips the comparison entirely for a \"dev\" client." >&2
  exit 1
fi

echo "[deploy] stamp     : $APP_VERSION ($GIT_SHA, $BUILT_AT)"
echo "[deploy] services  : ${SERVICES[*]}"

if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  echo "[deploy] migrating database before touching the api…"
  "${COMPOSE[@]}" up --build db-migrate
fi

# --wait, because `up -d` returns as soon as the containers have been CREATED:
# it blocks on the depends_on chain, never on the healthchecks of the services
# you actually named. A container that starts and dies a second later is fully
# compatible with `up -d` exiting 0, and that is precisely the window the
# verification below is supposed to cover — it cannot verify anything against a
# stack that is still coming up (or already gone).
# db-migrate is the one service this must not be used on: it is a one-shot that
# exits by design, and --wait reports an exited container as a failure. This
# script runs it in the foreground above; the exclusion is only here for the
# operator who passes it as an explicit argument.
UP_ARGS=(up -d --build)
case " ${SERVICES[*]} " in
  *" db-migrate "*) ;;
  # web's healthcheck allows 90s start_period + 8×15s, api's 45s + 10×10s, so
  # the bound is generous — it exists so a wedged container cannot hang a
  # detached deploy forever instead of failing it.
  *) UP_ARGS+=(--wait --wait-timeout "${DEPLOY_WAIT_TIMEOUT:-420}") ;;
esac

echo "[deploy] rebuilding ${SERVICES[*]} (the old containers keep serving until the swap)…"
"${COMPOSE[@]}" "${UP_ARGS[@]}" "${SERVICES[@]}"

# .env.prod is hand-edited and inline `# …` annotations are a supported feature
# everywhere else — start-unix.sh strips them in val_for_key and sanitizes a
# comment-free copy for Compose — and the shipped template really does ship
# `DOMAIN=onetothree.ru   # авто-заполняется из ./secrets/domain`. Taking the
# whole rest of the line built `https://api.onetothree.ru   # …/api/version`,
# a URL curl can only fail on, which used to read as "api unreachable" and,
# before the exit status below existed, as "done.".
domain_from_env_prod() {
  local line val
  line="$(grep -E '^[[:space:]]*DOMAIN=' .env.prod 2>/dev/null | tail -n1 || true)"
  [ -n "$line" ] || return 1
  val="${line#*=}"
  val="${val//$'\r'/}"
  val="${val%%#*}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  val="${val#\"}"
  val="${val%\"}"
  val="${val#\'}"
  val="${val%\'}"
  [ -n "$val" ] || return 1
  printf '%s\n' "$val"
}

# Verify the stamp actually reached both halves — a silent "dev" is the exact
# failure this script exists to prevent, so do not trust the build log alone.
#
# An ABSENT answer counts as a failure, not as "unknown". An api that does not
# respond, or a forestmessenger-web-1 that is missing or restarting, is a worse
# outcome than a version mismatch; the old `if [ -n "$served" ]` guards meant
# the worst case was the one case that printed nothing at all and still exited 0.
echo "[deploy] verifying…"
verify_failed=0

# A partial deploy legitimately leaves the OTHER half on its previous stamp
# (`scripts/deploy-prod.sh web` is a documented usage), so only the halves we
# just rebuilt have to match. Unreachable is still unreachable either way.
case " ${SERVICES[*]} " in *" api "*) rebuilt_api=1 ;; *) rebuilt_api=0 ;; esac
case " ${SERVICES[*]} " in *" web "*) rebuilt_web=1 ;; *) rebuilt_web=0 ;; esac

if ! domain="$(domain_from_env_prod)"; then
  echo "[deploy] FAILED: no usable DOMAIN= in .env.prod — cannot probe the api." >&2
  verify_failed=1
else
  served="$(curl -sS --max-time 10 "https://api.${domain}/api/version" 2>/dev/null || true)"
  echo "[deploy] GET /api/version -> ${served:-<unreachable>}"
  if [ -z "$served" ]; then
    echo "[deploy] FAILED: https://api.${domain}/api/version did not answer — the api is not serving." >&2
    verify_failed=1
  elif ! printf '%s' "$served" | grep -qF "$APP_VERSION"; then
    if [ "$rebuilt_api" = "1" ]; then
      echo "[deploy] FAILED: the api reports a different version than we just built ($APP_VERSION)." >&2
      verify_failed=1
    else
      echo "[deploy] note: the api still reports its previous version — it was not part of this deploy." >&2
    fi
  fi
fi

baked="$(docker exec forestmessenger-web-1 sh -c 'grep -h NEXT_PUBLIC_APP_VERSION /app/.env.production 2>/dev/null' 2>/dev/null || true)"
echo "[deploy] client bundle    -> ${baked:-<unknown>}"
if [ -z "$baked" ]; then
  echo "[deploy] FAILED: could not read NEXT_PUBLIC_APP_VERSION out of forestmessenger-web-1 — the container is missing, restarting, or the bundle was built without a stamp." >&2
  verify_failed=1
elif ! printf '%s' "$baked" | grep -qF "$APP_VERSION"; then
  if [ "$rebuilt_web" = "1" ]; then
    echo "[deploy] FAILED: the client bundle was baked with a different version than we just built ($APP_VERSION) — the reload banner will misbehave." >&2
    verify_failed=1
  else
    echo "[deploy] note: the client bundle still carries its previous version — web was not part of this deploy." >&2
  fi
fi

if [ "$verify_failed" != "0" ]; then
  echo "[deploy] FAILED: the containers were rebuilt but verification did not pass — see above. Prod may be serving the old build, or nothing at all." >&2
  exit 1
fi

echo "[deploy] done."
