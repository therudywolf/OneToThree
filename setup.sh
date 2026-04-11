#!/usr/bin/env bash
# =============================================================================
# Project 13 — Single-Claw production ignition (Linux / WSL / macOS)
# :: One script: env bootstrap → secrets → compose up → migrations (via compose)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
MAG='\033[0;35m'
NC='\033[0m'

log() { echo -e "${CYAN}::${NC} $*"; }
warn() { echo -e "${RED}[!]${NC} $*"; }
noir() { echo -e "${MAG}$*${NC}"; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    warn "Required command not found: $1"
    exit 1
  fi
}

need_cmd docker
need_cmd openssl

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

ENV_TEMPLATE=""
if [[ -f "${ROOT}/.env.prod.example" ]]; then
  ENV_TEMPLATE="${ROOT}/.env.prod.example"
elif [[ -f "${ROOT}/env.prod.example" ]]; then
  ENV_TEMPLATE="${ROOT}/env.prod.example"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -z "$ENV_TEMPLATE" ]]; then
    warn "Missing ${ENV_FILE} and no .env.prod.example / env.prod.example to copy."
    exit 1
  fi
  log "Creating ${ENV_FILE} from template…"
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  warn "Edit ${ENV_FILE}: set POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, CORS_ORIGIN (and domain URLs)."
  read -r -p "Press Enter when you have saved required values (or Ctrl+C to abort)…" || true
fi

# --- In-place env line replace (handles VAPID / arbitrary values) ------------
update_key() {
  local key="$1"
  local val="$2"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]]; then
    grep -v "^${key}=" "$ENV_FILE" >"$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" "$ENV_FILE"
}

val_for_key() {
  local key="$1"
  local line
  line=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  [[ -z "$line" ]] && { echo ""; return; }
  local val="${line#*=}"
  val="${val//$'\r'/}"
  val="${val#\"}"
  val="${val%\"}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  echo "$val"
}

needs_secret() {
  local v="$1"
  [[ -z "$v" ]] && return 0
  case "$v" in
    change-me | change-me-strong | change-me-64-char-random | CHANGE_ME) return 0 ;;
  esac
  [[ "$v" == change-me-* ]] && return 0
  [[ "$v" == *yourdomain* ]] && return 0
  return 1
}

# --- Auto-generate weak / empty secrets -------------------------------------
JWT_CUR=$(val_for_key JWT_SECRET)
if needs_secret "$JWT_CUR"; then
  NEW_JWT=$(openssl rand -hex 32)
  update_key JWT_SECRET "$NEW_JWT"
  log "Generated JWT_SECRET (64 hex)."
fi

WH_CUR=$(val_for_key WEBHOOK_SECRET)
if needs_secret "$WH_CUR"; then
  NEW_WH=$(openssl rand -hex 32)
  update_key WEBHOOK_SECRET "$NEW_WH"
  log "Generated WEBHOOK_SECRET (64 hex)."
fi

VPUB=$(val_for_key VAPID_PUBLIC_KEY)
VPRIV=$(val_for_key VAPID_PRIVATE_KEY)
if needs_secret "$VPUB" || needs_secret "$VPRIV"; then
  if docker info >/dev/null 2>&1; then
    TMPV=$(mktemp)
    if docker run --rm node:20-alpine sh -c \
      'cd /tmp && npm install web-push@3.6.7 --silent 2>/dev/null && node -e "process.chdir(\"/tmp\");const {generateVAPIDKeys}=require(\"web-push\");const k=generateVAPIDKeys();console.log(k.publicKey);console.log(k.privateKey)"' \
      >"$TMPV" 2>/dev/null
    then
      PUB=$(sed -n '1p' "$TMPV" | tr -d '\r')
      PRIV=$(sed -n '2p' "$TMPV" | tr -d '\r')
      rm -f "$TMPV"
      if [[ -n "$PUB" && -n "$PRIV" ]]; then
        update_key VAPID_PUBLIC_KEY "$PUB"
        update_key VAPID_PRIVATE_KEY "$PRIV"
        update_key NEXT_PUBLIC_VAPID_PUBLIC_KEY "$PUB"
        log "Generated VAPID key pair + synced NEXT_PUBLIC_VAPID_PUBLIC_KEY."
      fi
    else
      rm -f "$TMPV"
    fi
  fi
  VPUB=$(val_for_key VAPID_PUBLIC_KEY)
  if needs_secret "$VPUB"; then
    warn "VAPID keys not generated (Docker unavailable or keygen failed). Set VAPID_* manually for push."
  fi
fi

# --- TLS (Automatic Shield — Let's Encrypt via Caddy) ------------------------
log "TLS: Caddy will obtain Let's Encrypt certificates automatically."
log "    Ensure DNS A/AAAA for onetothree.ru, api.*, s3.* → this host, and ports 80/443 are open."

# --- Required keys (operator must set) --------------------------------------
check_key() {
  local key="$1"
  local line val
  line=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  if [[ -z "$line" ]]; then
    warn "Missing ${key}= in ${ENV_FILE}"
    return 1
  fi
  val="${line#*=}"
  val="${val//$'\r'/}"
  val="${val#\"}"
  val="${val%\"}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ -z "$val" ]]; then
    warn "${key} is empty in ${ENV_FILE}"
    return 1
  fi
  if needs_secret "$val" && [[ "$key" != "JWT_SECRET" && "$key" != "WEBHOOK_SECRET" && "$key" != "VAPID_PUBLIC_KEY" && "$key" != "VAPID_PRIVATE_KEY" && "$key" != "NEXT_PUBLIC_VAPID_PUBLIC_KEY" ]]; then
    warn "${key} still uses a placeholder — set a strong value in ${ENV_FILE}"
    return 1
  fi
  return 0
}

MISSING=0
for key in POSTGRES_PASSWORD MINIO_ROOT_PASSWORD CORS_ORIGIN JWT_SECRET; do
  check_key "$key" || MISSING=1
done
if [[ "$MISSING" -ne 0 ]]; then
  exit 1
fi

# --- Cross-subdomain session (fm_session must reach Next on apex + Fastify on api.*) -----
web_host_from_cors() {
  local raw
  raw=$(val_for_key CORS_ORIGIN | cut -d',' -f1 | tr -d '\r')
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  echo "${raw#http://}" | sed 's|^https://||' | cut -d'/' -f1
}
api_host_from_env() {
  local raw
  raw=$(val_for_key NEXT_PUBLIC_API_URL | tr -d '\r')
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  echo "${raw#http://}" | sed 's|^https://||' | cut -d'/' -f1
}
WEB_HOST=$(web_host_from_cors)
API_HOST=$(api_host_from_env)
COOKIE_DOM=$(val_for_key COOKIE_DOMAIN | tr -d '\r')
if [[ -n "$API_HOST" && -n "$WEB_HOST" && "$API_HOST" != "$WEB_HOST" && -z "$COOKIE_DOM" ]]; then
  warn "NEXT_PUBLIC_API_URL host (${API_HOST}) differs from CORS_ORIGIN host (${WEB_HOST}) but COOKIE_DOMAIN is empty."
  warn "Set COOKIE_DOMAIN=.your-apex-domain in ${ENV_FILE} so fm_session is shared (avoids /login redirect loop)."
fi

log "Building and starting stack (${COMPOSE_FILE}, env: ${ENV_FILE})…"
"${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

log "Waiting for healthchecks (db-migrate runs as a compose dependency)…"
"${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps

# --- Noir completion banner -------------------------------------------------
PRIMARY_IP=""
if command -v hostname >/dev/null 2>&1; then
  PRIMARY_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
if [[ -z "$PRIMARY_IP" ]] && command -v ip >/dev/null 2>&1; then
  PRIMARY_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)
fi
DOMAIN_HINT=$(val_for_key CORS_ORIGIN | cut -d',' -f1 | sed 's|https\?://||' | sed 's|/.*||')

echo ""
noir "  ┌──────────────────────────────────────────────────────────┐"
noir "  │  :: CHANNEL OPEN — Project 13 (Forest Messenger)         │"
noir "  │  Stack is launching in the background.                   │"
noir "  └──────────────────────────────────────────────────────────┘"
echo -e "${DIM}  Host: ${PRIMARY_IP:-unknown}   Origin hint: ${DOMAIN_HINT:-—}${NC}"
echo -e "${DIM}  Logs API: ${DC[*]} -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs -f api${NC}"
echo -e "${DIM}  Logs TLS: ${DC[*]} -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs -f caddy${NC}"
echo -e "${DIM}  Warden: first admin — see README (bootstrap / SQL).${NC}"
echo ""
