#!/usr/bin/env bash
# OneToThree uptime check — pings api/web health and reports to a
# Healthchecks.io-style heartbeat URL.
#
# Designed for a systemd timer that runs every minute (see infra/systemd/).
# UPTIME_HEALTHCHECK_URL is mandatory; everything else has sane defaults.

set -uo pipefail

API_URL="${UPTIME_API_URL:-https://api.onetothree.ru/health}"
WEB_URL="${UPTIME_WEB_URL:-https://onetothree.ru/}"
HEALTHCHECK_URL="${UPTIME_HEALTHCHECK_URL:-}"

log() { printf '%s [uptime] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

probe() {
  local label="$1" url="$2" expected="$3"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 "$url" || echo '000')"
  if [[ "$code" == "$expected" ]]; then
    log "$label OK ($code)"
    return 0
  fi
  log "$label FAIL — got $code, want $expected from $url"
  return 1
}

ok=true
probe api "$API_URL" 200 || ok=false
# web returns 307 (redirect to /login) for unauthenticated GETs — that
# means the next.js standalone server is responding, which is what we
# care about for liveness.
probe web "$WEB_URL" 307 || ok=false

if [[ -z "$HEALTHCHECK_URL" ]]; then
  $ok || exit 1
  exit 0
fi

if $ok; then
  curl -fsS --retry 3 -m 10 -o /dev/null "$HEALTHCHECK_URL"
  exit 0
fi
curl -fsS --retry 3 -m 10 -o /dev/null "${HEALTHCHECK_URL}/fail"
exit 1
