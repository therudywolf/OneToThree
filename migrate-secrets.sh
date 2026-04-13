#!/usr/bin/env bash
# ============================================================================
# migrate-secrets.sh — ONE-TIME credential rotation after git history leak
# Run ONCE on production, then delete this script.
#
# What it does:
#   1. Reads .env.prod.old (your current working env)
#   2. Generates new passwords / secrets for everything that leaked
#   3. Writes a new .env.prod with fresh credentials
#   4. Updates PostgreSQL password inside the running container
#   5. Restarts the stack so all services pick up new credentials
#
# Prerequisites:
#   - Stack is running (docker compose up)
#   - .env.prod.old exists in the project root
#   - You are in the project root (~/ForestMessenger or wherever)
#
# Usage:
#   chmod +x migrate-secrets.sh
#   ./migrate-secrets.sh
# ============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.prod.yml"
OLD_ENV=".env.prod.old"
NEW_ENV=".env.prod"
BACKUP_ENV=".env.prod.backup.$(date +%Y%m%d_%H%M%S)"

# --- helpers ---------------------------------------------------------------

log()  { echo -e "${GREEN}[migrate]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

rand_hex()  { openssl rand -hex "$1"; }
rand_pass() { openssl rand -base64 "$1" | tr -d '/+=' | head -c "$1"; }

read_old() {
  # Read a value from .env.prod.old; returns empty string if not found
  # grep exit code 1 (no match) is suppressed — safe with set -e
  { grep -E "^${1}=" "$OLD_ENV" 2>/dev/null || true; } | head -1 | cut -d'=' -f2-
}

# --- preflight -------------------------------------------------------------

[[ -f "$OLD_ENV" ]] || err "$OLD_ENV not found. Place your old env file in the project root."
[[ -f "$COMPOSE_FILE" ]] || err "$COMPOSE_FILE not found. Are you in the project root?"

command -v openssl >/dev/null || err "openssl is required"
command -v docker  >/dev/null || err "docker is required"

# --- read preserved values from old env ------------------------------------

log "Reading preserved values from $OLD_ENV …"

# These stay the same — they're infrastructure, not secrets that leaked:
POSTGRES_USER="$(read_old POSTGRES_USER)"
POSTGRES_DB="$(read_old POSTGRES_DB)"
CORS_ORIGIN="$(read_old CORS_ORIGIN)"
_vapid_subject="$(read_old VAPID_SUBJECT)"
ACME_EMAIL="${_vapid_subject#mailto:}"
# Fallback: try reading ACME_EMAIL directly if set
if [[ -z "$ACME_EMAIL" ]]; then
  ACME_EMAIL="$(read_old ACME_EMAIL)"
fi
COOKIE_DOMAIN="$(read_old COOKIE_DOMAIN)"
NEXT_PUBLIC_API_URL="$(read_old NEXT_PUBLIC_API_URL)"
NEXT_PUBLIC_WS_ORIGIN="$(read_old NEXT_PUBLIC_WS_ORIGIN)"
MINIO_ROOT_USER="$(read_old MINIO_ROOT_USER)"
MINIO_BUCKET="$(read_old MINIO_BUCKET)"
MINIO_BUCKET_AVATARS="$(read_old MINIO_BUCKET_AVATARS)"
MINIO_PUBLIC_URL="$(read_old MINIO_PUBLIC_URL)"
MINIO_CORS_ORIGINS="$(read_old MINIO_CORS_ORIGINS)"
TURN_USERNAME="$(read_old TURN_USERNAME)"
NEXT_PUBLIC_TURN_URL="$(read_old NEXT_PUBLIC_TURN_URL)"
VAPID_SUBJECT="$(read_old VAPID_SUBJECT)"

# Old passwords (needed to update postgres)
OLD_PG_PASS="$(read_old POSTGRES_PASSWORD)"

# Defaults
POSTGRES_USER="${POSTGRES_USER:-forest}"
POSTGRES_DB="${POSTGRES_DB:-forest}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minio}"
MINIO_BUCKET="${MINIO_BUCKET:-project13-media}"
MINIO_BUCKET_AVATARS="${MINIO_BUCKET_AVATARS:-project13-avatars}"
TURN_USERNAME="${TURN_USERNAME:-rudy}"
NEXT_PUBLIC_TURN_URL="${NEXT_PUBLIC_TURN_URL:-turn:turn.onetothree.ru:3478}"

# --- detect TURN_EXTERNAL_IP -----------------------------------------------

TURN_EXTERNAL_IP="$(read_old TURN_EXTERNAL_IP)"
if [[ -z "$TURN_EXTERNAL_IP" ]]; then
  TURN_EXTERNAL_IP="$(curl -s --max-time 5 ifconfig.me || true)"
  log "Auto-detected TURN_EXTERNAL_IP=$TURN_EXTERNAL_IP"
fi

# --- generate new secrets ---------------------------------------------------

log "Generating new credentials …"

NEW_PG_PASS="$(rand_pass 32)"
NEW_MINIO_PASS="$(rand_pass 32)"
NEW_JWT_SECRET="$(rand_hex 32)"
NEW_WEBHOOK_SECRET="$(rand_hex 32)"
NEW_TURN_PASS="$(rand_pass 24)"

# Generate VAPID keys
log "Generating VAPID key pair …"
VAPID_JSON="$(docker run --rm node:20-alpine sh -c \
  "npx --yes web-push generate-vapid-keys --json 2>/dev/null")"
NEW_VAPID_PUBLIC="$(echo "$VAPID_JSON" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)"
NEW_VAPID_PRIVATE="$(echo "$VAPID_JSON" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)"

if [[ -z "$NEW_VAPID_PUBLIC" || -z "$NEW_VAPID_PRIVATE" ]]; then
  err "Failed to generate VAPID keys. Is Docker running?"
fi

# --- backup old env ---------------------------------------------------------

if [[ -f "$NEW_ENV" ]]; then
  cp "$NEW_ENV" "$BACKUP_ENV"
  log "Backed up current $NEW_ENV → $BACKUP_ENV"
fi

# --- write new .env.prod ----------------------------------------------------

log "Writing new $NEW_ENV …"

cat > "$NEW_ENV" << ENVEOF
# =============================================================================
# Forest Messenger — Production Environment
# Generated by migrate-secrets.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# =============================================================================

# --- PostgreSQL ---------------------------------------------------------------
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${NEW_PG_PASS}
POSTGRES_DB=${POSTGRES_DB}
DATABASE_URL=postgresql://${POSTGRES_USER}:${NEW_PG_PASS}@db:5432/${POSTGRES_DB}

# --- MinIO (S3) ---------------------------------------------------------------
MINIO_ROOT_USER=${MINIO_ROOT_USER}
MINIO_ROOT_PASSWORD=${NEW_MINIO_PASS}
MINIO_BUCKET=${MINIO_BUCKET}
MINIO_BUCKET_AVATARS=${MINIO_BUCKET_AVATARS}
MINIO_PUBLIC_URL=${MINIO_PUBLIC_URL}
MINIO_CORS_ORIGINS=${MINIO_CORS_ORIGINS}

# --- CORS / Proxy -------------------------------------------------------------
CORS_ORIGIN=${CORS_ORIGIN}
TRUST_PROXY=1
COOKIE_SECURE=1
COOKIE_DOMAIN=${COOKIE_DOMAIN}

# --- Next.js public URLs ------------------------------------------------------
NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
NEXT_PUBLIC_WS_ORIGIN=${NEXT_PUBLIC_WS_ORIGIN}

# --- Auth & Secrets (newly generated) ----------------------------------------
JWT_SECRET=${NEW_JWT_SECRET}
WEBHOOK_SECRET=${NEW_WEBHOOK_SECRET}

# --- VAPID (Web Push) --------------------------------------------------------
VAPID_SUBJECT=${VAPID_SUBJECT}
VAPID_PUBLIC_KEY=${NEW_VAPID_PUBLIC}
VAPID_PRIVATE_KEY=${NEW_VAPID_PRIVATE}
NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEW_VAPID_PUBLIC}

# --- TURN (WebRTC relay) -----------------------------------------------------
TURN_EXTERNAL_IP=${TURN_EXTERNAL_IP}
TURN_USERNAME=${TURN_USERNAME}
TURN_PASSWORD=${NEW_TURN_PASS}
NEXT_PUBLIC_TURN_URL=${NEXT_PUBLIC_TURN_URL}
NEXT_PUBLIC_TURN_USERNAME=${TURN_USERNAME}
NEXT_PUBLIC_TURN_PASSWORD=${NEW_TURN_PASS}

# --- Let's Encrypt ------------------------------------------------------------
ACME_EMAIL=${ACME_EMAIL}

# --- Media retention ----------------------------------------------------------
MEDIA_RETENTION_ENABLED=1
MEDIA_RETENTION_DAYS=21
ENVEOF

chmod 600 "$NEW_ENV"
log "New $NEW_ENV written (chmod 600)"

# --- update PostgreSQL password inside running container ---------------------

log "Updating PostgreSQL password inside running container …"

DB_CONTAINER="$(docker compose -f "$COMPOSE_FILE" --env-file "$OLD_ENV" ps -q db 2>/dev/null || true)"
DB_CONTAINER="${DB_CONTAINER:-}"

if [[ -z "$DB_CONTAINER" ]]; then
  warn "DB container not running. Start the stack with the OLD env first:"
  warn "  docker compose -f $COMPOSE_FILE --env-file $OLD_ENV up -d db"
  warn "  Then re-run this script."
  exit 1
fi

# Use old password to connect and change to new password
docker compose -f "$COMPOSE_FILE" --env-file "$OLD_ENV" exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER USER ${POSTGRES_USER} WITH PASSWORD '${NEW_PG_PASS}';" \
  && log "PostgreSQL password updated ✓" \
  || err "Failed to update PostgreSQL password"

# --- restart stack with new env ---------------------------------------------

log "Stopping stack …"
docker compose -f "$COMPOSE_FILE" --env-file "$OLD_ENV" down

log "Starting stack with new credentials …"
docker compose -f "$COMPOSE_FILE" --env-file "$NEW_ENV" up -d --build

# --- wait for health --------------------------------------------------------

log "Waiting for services to come up …"
sleep 10

if docker compose -f "$COMPOSE_FILE" --env-file "$NEW_ENV" ps | grep -q "Up"; then
  log ""
  log "═══════════════════════════════════════════════════════════"
  log "  Migration complete!"
  log "═══════════════════════════════════════════════════════════"
  log ""
  log "  New .env.prod written with fresh credentials"
  log "  PostgreSQL password rotated inside the database"
  log "  VAPID keys regenerated (users will need to re-subscribe to push)"
  log "  JWT secret rotated (active sessions will be invalidated)"
  log ""
  log "  Backup of old env: $BACKUP_ENV"
  log ""
  log "  ⚠  DELETE this script after confirming everything works:"
  log "     rm migrate-secrets.sh .env.prod.old"
  log ""
  docker compose -f "$COMPOSE_FILE" --env-file "$NEW_ENV" ps
else
  err "Some services may not have started. Check: docker compose -f $COMPOSE_FILE --env-file $NEW_ENV logs"
fi
