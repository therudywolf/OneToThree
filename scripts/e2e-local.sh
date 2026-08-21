#!/usr/bin/env bash
# One-command local end-to-end verification — brings up a prod-shaped stack
# (Postgres + Redis + MinIO + API in test mode + production web + single-origin
# Caddy front) and runs the Playwright suite against it. Because everything is
# served from ONE origin (http://localhost:8090), the WebSocket upgrade carries
# the session cookie, so real-time delivery — chats, groups, calls — is exercised
# for real (unlike a bare `next start`, which can't proxy WS upgrades).
#
# Usage:
#   bash scripts/e2e-local.sh                 # full suite
#   bash scripts/e2e-local.sh chat-core.spec.ts auth.spec.ts   # specific specs
#   E2E_KEEP=1 bash scripts/e2e-local.sh      # leave the stack up afterwards
#   E2E_GREP="ciphertext" bash scripts/e2e-local.sh chat-core.spec.ts
#
# Exit code == Playwright's, so it drops straight into CI / post-release checks.
set -uo pipefail
cd "$(dirname "$0")/.."

ENVFILE=.env.e2e
# localhost (NOT 127.0.0.1): must match the build-time NEXT_PUBLIC_API_URL origin
# so the browser, REST and WS share one origin and the session cookie flows.
BASE_URL=http://localhost:8090
# ...but this script's own readiness probes must use the literal IPv4 address.
# Windows resolves `localhost` to ::1 first and Docker Desktop publishes on IPv4
# only, so curl gets "connection refused" against a stack that is fully healthy
# and this script spins for its whole timeout before declaring the API dead.
# Same reason playwright.config.ts pins Chromium's resolver and
# playwright.global-setup.ts rewrites its fetch targets. Only the probes change;
# the browser keeps the `localhost` origin the web image was built for.
PROBE_URL=http://127.0.0.1:8090
COMPOSE=(docker compose --env-file "$ENVFILE" -f docker-compose.yml -f docker-compose.e2e.yml)
SERVICES=(db redis minio db-migrate api web-e2e caddy)

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[e2e]\033[0m %s\n' "$*" >&2; }

# 1. Ephemeral dev secrets (gitignored). Regenerated only if missing.
if [ ! -f "$ENVFILE" ]; then
  JWT=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  TWK=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  printf 'JWT_SECRET=%s\nTOTP_WRAP_KEY=%s\n' "$JWT" "$TWK" > "$ENVFILE"
  log "generated $ENVFILE"
fi

cleanup() {
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    log "E2E_KEEP=1 — leaving stack up. Tear down: ${COMPOSE[*]} down -v"
  else
    log "tearing down stack..."
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 2. Build + start.
log "building + starting stack (${SERVICES[*]})..."
if ! "${COMPOSE[@]}" up -d --build "${SERVICES[@]}"; then
  err "stack failed to start"; "${COMPOSE[@]}" logs --tail 40 api web-e2e caddy; exit 1
fi

# 3. Wait for the single-origin front to be healthy + the app to render.
log "waiting for $BASE_URL ..."
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "$PROBE_URL/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 3
done
[ "$ready" = "1" ] || { err "API health never came up"; "${COMPOSE[@]}" logs --tail 50 api caddy; exit 1; }
app=0
for _ in $(seq 1 40); do
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$PROBE_URL/login" || echo 0)" = "200" ] && { app=1; break; }
  sleep 3
done
[ "$app" = "1" ] || { err "web app never rendered /login"; "${COMPOSE[@]}" logs --tail 50 web-e2e caddy; exit 1; }
log "stack ready at $BASE_URL"

# 4. Run Playwright against the single-origin Caddy.
export PLAYWRIGHT_SKIP_WEBSERVER=1
export PLAYWRIGHT_BASE_URL="$BASE_URL"
export PLAYWRIGHT_API_HEALTH="$BASE_URL/health"
GREP_ARGS=()
[ -n "${E2E_GREP:-}" ] && GREP_ARGS=(-g "$E2E_GREP")
log "running playwright..."
# The mobile-parity suite runs on the mobile projects, so pinning chromium
# skipped it entirely in the one command the docs tell people to run. Override
# with E2E_PROJECTS="chromium mobile-android" (webkit needs `npx playwright
# install webkit` for the iOS project).
PROJECT_ARGS=()
for proj in ${E2E_PROJECTS:-chromium}; do PROJECT_ARGS+=(--project="$proj"); done
npx playwright test --config client/playwright.config.ts "${PROJECT_ARGS[@]}" "${GREP_ARGS[@]}" "$@"
code=$?
[ "$code" = "0" ] && log "ALL GREEN ✅" || err "playwright failed (exit $code)"
exit "$code"
