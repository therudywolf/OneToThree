#!/usr/bin/env bash
# sync-turn-certs.sh — copy the Let's Encrypt cert Caddy manages into the
# location coturn reads on container startup.
#
# Run once after the first successful ACME issuance, and then from cron
# (`0 4 * * * /opt/forest/scripts/sync-turn-certs.sh --quiet`).
#
# Exit 0 on success, non-zero otherwise.
set -euo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env.prod}"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.prod.yml}"
TLS_OUT="$REPO_DIR/docker/coturn/tls"

QUIET=0
RESTART_COTURN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet)
      QUIET=1
      ;;
    --no-restart)
      RESTART_COTURN=0
      ;;
    --host)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "[sync-turn-certs][ERR] --host requires a hostname" >&2
        exit 64
      fi
      TURN_HOST="$2"
      shift 2
      continue
      ;;
    *)
      echo "[sync-turn-certs][ERR] Unknown argument: $1" >&2
      exit 64
      ;;
  esac
  shift
done

log() {
  if [[ $QUIET -eq 0 ]]; then
    echo "[sync-turn-certs] $*"
  fi
}

err() {
  echo "[sync-turn-certs][ERR] $*" >&2
}

env_val() {
  local key="$1"
  local line val
  [[ -f "$ENV_FILE" ]] || { echo ""; return; }
  line=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  [[ -z "$line" ]] && { echo ""; return; }
  val="${line#*=}"
  val="${val%%#*}"
  val="${val//$'\r'/}"
  val="${val#\"}" val="${val%\"}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  echo "$val"
}

turn_host_from_url() {
  local raw="$1" first rest host_port
  raw="${raw//[[:space:]]/}"
  first="${raw%%,*}"
  [[ -z "$first" ]] && return 1
  case "$first" in
    turn:*) rest="${first#turn:}" ;;
    turns:*) rest="${first#turns:}" ;;
    *) return 1 ;;
  esac
  rest="${rest##*@}"
  host_port="${rest%%[/?#]*}"
  if [[ "$host_port" == \[*\]* ]]; then
    echo "${host_port%%]*}]"
  else
    echo "${host_port%%:*}"
  fi
}

resolve_turn_host() {
  local host domain urls
  host="${TURN_HOST:-}"
  [[ -n "$host" ]] && { echo "$host"; return; }
  urls="$(env_val NEXT_PUBLIC_TURN_URLS)"
  host="$(turn_host_from_url "$urls" 2>/dev/null || true)"
  [[ -n "$host" ]] && { echo "$host"; return; }
  urls="$(env_val TURN_URLS)"
  host="$(turn_host_from_url "$urls" 2>/dev/null || true)"
  [[ -n "$host" ]] && { echo "$host"; return; }
  urls="$(env_val NEXT_PUBLIC_TURN_URL)"
  host="$(turn_host_from_url "$urls" 2>/dev/null || true)"
  [[ -n "$host" ]] && { echo "$host"; return; }
  domain="$(env_val DOMAIN)"
  [[ -n "$domain" ]] && { echo "turn.$domain"; return; }
  echo "turn.onetothree.ru"
}

compose_project_name() {
  local from_env from_file
  from_env="${COMPOSE_PROJECT_NAME:-}"
  [[ -n "$from_env" ]] && { echo "$from_env"; return; }
  from_file="$(awk '/^[[:space:]]*name:[[:space:]]*/ {print $2; exit}' "$COMPOSE_FILE" 2>/dev/null || true)"
  [[ -n "$from_file" ]] && { echo "$from_file"; return; }
  echo "forestmessenger"
}

TURN_HOST="$(resolve_turn_host)"
COMPOSE_PROJECT="$(compose_project_name)"
CADDY_VOLUME_NAME="${CADDY_VOLUME_NAME:-${COMPOSE_PROJECT}_caddy_data}"

if ! command -v docker >/dev/null 2>&1; then
  err "Docker CLI not found"
  exit 2
fi
if ! docker version >/dev/null 2>&1; then
  err "Docker CLI is not available in this environment"
  exit 2
fi

# Locate the Caddy data volume for the active compose project.
CADDY_VOL="$(docker volume inspect "$CADDY_VOLUME_NAME" --format '{{ .Mountpoint }}' 2>/dev/null || true)"
if [[ -z "$CADDY_VOL" ]]; then
  err "Caddy data volume not found: $CADDY_VOLUME_NAME. Is docker-compose.prod up?"
  exit 2
fi

SRC_ROOT="$CADDY_VOL/caddy/certificates"
SRC="$(find "$SRC_ROOT" -type d -name "$TURN_HOST" 2>/dev/null | head -1 || true)"
if [[ ! -d "$SRC" ]]; then
  err "Certificate directory missing for $TURN_HOST under $SRC_ROOT"
  err "Make sure Caddy has a site block for $TURN_HOST that forces TLS provisioning"
  err "and DNS/ports allow ACME issuance."
  exit 3
fi
SRC_CRT="$SRC/$TURN_HOST.crt"
SRC_KEY="$SRC/$TURN_HOST.key"
if [[ ! -s "$SRC_CRT" || ! -s "$SRC_KEY" ]]; then
  err "Certificate files are incomplete in $SRC"
  exit 3
fi
if command -v openssl >/dev/null 2>&1; then
  if ! openssl x509 -in "$SRC_CRT" -noout -checkend 86400 >/dev/null 2>&1; then
    err "Caddy certificate for $TURN_HOST is expired or expires within 24h"
    exit 4
  fi
fi

mkdir -p "$TLS_OUT"
changed=0
if [[ ! -f "$TLS_OUT/fullchain.pem" ]] || ! cmp -s "$SRC_CRT" "$TLS_OUT/fullchain.pem"; then
  changed=1
fi
if [[ ! -f "$TLS_OUT/privkey.pem" ]] || ! cmp -s "$SRC_KEY" "$TLS_OUT/privkey.pem"; then
  changed=1
fi

if [[ "$changed" -eq 1 ]]; then
  cp -f "$SRC_CRT" "$TLS_OUT/fullchain.pem"
  cp -f "$SRC_KEY" "$TLS_OUT/privkey.pem"
  chmod 0640 "$TLS_OUT/fullchain.pem" "$TLS_OUT/privkey.pem"
  log "Copied $TURN_HOST TLS material into $TLS_OUT"
else
  log "TURN TLS material is already current for $TURN_HOST"
fi

# Restart coturn so it reloads the new key material.
if [[ "$RESTART_COTURN" -eq 1 && "$changed" -eq 1 ]] \
  && docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps coturn >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart coturn >/dev/null
  log "coturn restarted"
fi

exit 0
