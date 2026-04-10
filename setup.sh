#!/usr/bin/env bash
# =============================================================================
# Project 13 — "Single Claw" production launcher (host: Linux / WSL / macOS)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
NC='\033[0m'

log() { echo -e "${CYAN}::${NC} $*"; }
warn() { echo -e "${RED}[!]${NC} $*"; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    warn "Required command not found: $1"
    exit 1
  fi
}

need_cmd docker

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  warn "Install Docker Compose (v2: \`docker compose\` or v1: \`docker-compose\`)."
  exit 1
fi

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"

if [[ ! -f "$ENV_FILE" ]]; then
  warn "Missing ${ENV_FILE}. Copy env.prod.example → ${ENV_FILE} and set secrets."
  exit 1
fi

if [[ ! -f "${ROOT}/certs/cert.pem" ]]; then
  warn "./certs/cert.pem not found — Caddy TLS will fail until PEM + key are mounted."
  warn "  Place cert.pem and key.pem under ./certs/ (see Caddyfile)."
fi

# Minimal sanity: required keys must be present with non-empty values in .env.prod
check_key() {
  local key="$1"
  local line
  line=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  if [[ -z "$line" ]]; then
    warn "Missing ${key}= in ${ENV_FILE}"
    return 1
  fi
  local val="${line#*=}"
  val="${val//$'\r'/}"
  val="${val#\"}"
  val="${val%\"}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ -z "$val" ]]; then
    warn "${key} is empty in ${ENV_FILE}"
    return 1
  fi
  return 0
}

MISSING=0
for key in POSTGRES_PASSWORD JWT_SECRET MINIO_ROOT_PASSWORD CORS_ORIGIN; do
  check_key "$key" || MISSING=1
done
if [[ "$MISSING" -ne 0 ]]; then
  exit 1
fi

log "Building and starting stack (${COMPOSE_FILE}, env: ${ENV_FILE})…"
"${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

log "Waiting for db-migrate (one-shot) and healthchecks…"
"${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps

log "Done. Logs: ${DC[*]} -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs -f api"
echo -e "${DIM}Tip: first admin — see README § Warden / bootstrap.${NC}"
