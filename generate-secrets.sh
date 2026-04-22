#!/usr/bin/env bash
# =============================================================================
# OneToThree (Forest Messenger) — One-Time Secret Generator
# =============================================================================
# Generates all required secrets, writes them as individual files in ./secrets/
# (Docker secrets format — one value per file), and displays them ONCE.
#
# Usage:
#   chmod +x generate-secrets.sh
#   ./generate-secrets.sh
#
# Secrets are NEVER committed to git (./secrets/ is in .gitignore).
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
CYN='\033[0;36m'
BLD='\033[1m'
NC='\033[0m'

SECRETS_DIR="./secrets"
SECRETS_DONE="$SECRETS_DIR/.initialized"

if [[ -f "$SECRETS_DONE" ]]; then
  echo -e "${YEL}Secrets already initialized.${NC}"
  echo "To regenerate, delete ${SECRETS_DIR} and re-run."
  exit 0
fi

# --- Preflight ----------------------------------------------------------------
command -v openssl >/dev/null 2>&1 || { echo -e "${RED}openssl is required${NC}" >&2; exit 1; }

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# --- Generate secrets ---------------------------------------------------------
# Use hex to avoid URL-unsafe chars (/, +, =) that break DATABASE_URL parsing
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)
TOTP_WRAP_KEY=$(openssl rand -hex 32)
TURN_PASSWORD=$(openssl rand -hex 16)
BACKUP_ENCRYPTION_KEY=$(openssl rand -hex 32)
INTERNAL_API_SIGNING_KEY=$(openssl rand -hex 32)
CLUSTER_JOIN_TOKEN=$(openssl rand -hex 24)
# LiveKit: API key must be prefixed "API" (LiveKit convention), secret is hex-64.
LIVEKIT_API_KEY="APIforest_$(openssl rand -hex 10)"
LIVEKIT_API_SECRET=$(openssl rand -hex 32)

# Cloudflare Calls TURN — operator provides these from the CF dashboard (free tier).
# See: https://developers.cloudflare.com/calls/turn/generate-credentials/
# Leave blank to keep self-hosted coturn as the TURN source instead.
CLOUDFLARE_TURN_KEY_ID=""
CLOUDFLARE_TURN_API_TOKEN=""

resolve_turn_external_ip() {
  local domain="$1"
  local turn_host="turn.${domain}"
  local ip=""

  if command -v getent >/dev/null 2>&1; then
    ip=$(getent ahostsv4 "$turn_host" 2>/dev/null | awk '{print $1; exit}' || true)
  fi
  if [[ -z "$ip" ]] && command -v dig >/dev/null 2>&1; then
    ip=$(dig +short A "$turn_host" 2>/dev/null | head -n1 || true)
  fi
  if [[ -z "$ip" ]] && command -v nslookup >/dev/null 2>&1; then
    ip=$(nslookup "$turn_host" 2>/dev/null | awk '/^Address: /{print $2}' | head -n1 || true)
  fi
  if [[ -z "$ip" ]]; then
    ip=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || true)
  fi

  echo "$ip"
}

# --- Manual inputs ------------------------------------------------------------
echo ""
echo -e "${BLD}  Configure your deployment:${NC}"
echo ""
read -rp "  Enter your domain (e.g. onetothree.ru): " DOMAIN
read -rp "  Enter ACME email for TLS certs: " ACME_EMAIL
read -rp "  Enter VAPID contact email (e.g. admin@onetothree.ru): " VAPID_SUBJECT

echo ""
echo -e "${BLD}  Cloudflare Calls TURN (optional, orange-cloud compatible):${NC}"
echo -e "  Leave both blank to keep self-hosted coturn as the TURN source."
echo -e "  Dashboard → Calls → TURN → create app to obtain Key ID + API Token."
read -rp "  CLOUDFLARE_TURN_KEY_ID (blank to skip): " CLOUDFLARE_TURN_KEY_ID
if [[ -n "$CLOUDFLARE_TURN_KEY_ID" ]]; then
  read -rp "  CLOUDFLARE_TURN_API_TOKEN: " CLOUDFLARE_TURN_API_TOKEN
fi

CORS_ORIGIN="https://${DOMAIN}"
TURN_EXTERNAL_IP="$(resolve_turn_external_ip "$DOMAIN")"

if [[ -z "$TURN_EXTERNAL_IP" ]]; then
  echo -e "${RED}  Could not auto-detect TURN external IP.${NC}"
  read -rp "  Enter TURN server external IP manually: " TURN_EXTERNAL_IP
fi

if [[ -z "$TURN_EXTERNAL_IP" ]]; then
  echo -e "${RED}TURN external IP is required${NC}" >&2
  exit 1
fi

echo -e "${CYN}  TURN external IP: ${TURN_EXTERNAL_IP}${NC}"

# --- VAPID key generation (EC P-256 / base64url) -----------------------------
echo ""
echo -e "${CYN}  Generating VAPID keys...${NC}"
VAPID_PUBLIC_KEY=""
VAPID_PRIVATE_KEY=""

# Preferred: native openssl (fast, no network)
TMPKEY=$(mktemp)
if openssl ecparam -name prime256v1 -genkey -noout -out "$TMPKEY" 2>/dev/null; then
  VAPID_PRIVATE_KEY=$(openssl ec -in "$TMPKEY" -outform DER 2>/dev/null | tail -c +8 | head -c 32 | base64 | tr '+/' '-_' | tr -d '=\n')
  VAPID_PUBLIC_KEY=$(openssl ec -in "$TMPKEY" -pubout -outform DER 2>/dev/null | tail -c 65 | base64 | tr '+/' '-_' | tr -d '=\n')
fi
rm -f "$TMPKEY"

# Fallback: docker node (slow, pulls ~40MB image)
if [[ -z "$VAPID_PUBLIC_KEY" || -z "$VAPID_PRIVATE_KEY" ]]; then
  echo -e "${YEL}  openssl VAPID generation failed, trying Docker fallback...${NC}"
  VAPID_JSON=""
  if command -v docker >/dev/null 2>&1; then
    VAPID_JSON=$(docker run --rm node:20-alpine sh -c 'npm install -g web-push --silent 2>/dev/null && web-push generate-vapid-keys --json 2>/dev/null' 2>/dev/null || true)
    VAPID_PUBLIC_KEY=$(echo "$VAPID_JSON" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4 || true)
    VAPID_PRIVATE_KEY=$(echo "$VAPID_JSON" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4 || true)
  fi
fi

if [[ -z "$VAPID_PUBLIC_KEY" || -z "$VAPID_PRIVATE_KEY" ]]; then
  echo -e "${YEL}  VAPID generation failed. You must generate them manually:${NC}"
  echo -e "  npx web-push generate-vapid-keys"
  echo -e "  Then write the values to: ${SECRETS_DIR}/vapid_public_key and ${SECRETS_DIR}/vapid_private_key"
fi

# --- Write secret files (Docker secrets format — one value per file) ----------
echo -n "$POSTGRES_PASSWORD"    > "$SECRETS_DIR/postgres_password"
echo -n "$MINIO_ROOT_PASSWORD"  > "$SECRETS_DIR/minio_root_password"
echo -n "$JWT_SECRET"           > "$SECRETS_DIR/jwt_secret"
echo -n "$WEBHOOK_SECRET"       > "$SECRETS_DIR/webhook_secret"
echo -n "$TOTP_WRAP_KEY"        > "$SECRETS_DIR/totp_wrap_key"
echo -n "$TURN_PASSWORD"        > "$SECRETS_DIR/turn_password"
echo -n "$BACKUP_ENCRYPTION_KEY" > "$SECRETS_DIR/backup_encryption_key"
echo -n "$INTERNAL_API_SIGNING_KEY" > "$SECRETS_DIR/internal_api_signing_key"
echo -n "$CLUSTER_JOIN_TOKEN"   > "$SECRETS_DIR/cluster_join_token"
echo -n "$LIVEKIT_API_KEY"      > "$SECRETS_DIR/livekit_api_key"
echo -n "$LIVEKIT_API_SECRET"   > "$SECRETS_DIR/livekit_api_secret"
# CF TURN files always exist so docker-compose `secrets:` mount succeeds.
# Empty content -> api/ice-servers treats CF as "not configured" and falls
# back to coturn/STUN automatically.
echo -n "$CLOUDFLARE_TURN_KEY_ID"    > "$SECRETS_DIR/cloudflare_turn_key_id"
echo -n "$CLOUDFLARE_TURN_API_TOKEN" > "$SECRETS_DIR/cloudflare_turn_api_token"
echo -n "$ACME_EMAIL"           > "$SECRETS_DIR/acme_email"
echo -n "$TURN_EXTERNAL_IP"     > "$SECRETS_DIR/turn_external_ip"
echo -n "$CORS_ORIGIN"          > "$SECRETS_DIR/cors_origin"
echo -n "$DOMAIN"               > "$SECRETS_DIR/domain"
echo -n "mailto:${VAPID_SUBJECT}" > "$SECRETS_DIR/vapid_subject"

if [[ -n "$VAPID_PUBLIC_KEY" ]]; then
  echo -n "$VAPID_PUBLIC_KEY"   > "$SECRETS_DIR/vapid_public_key"
  echo -n "$VAPID_PRIVATE_KEY"  > "$SECRETS_DIR/vapid_private_key"
fi

chmod 600 "$SECRETS_DIR"/*

# --- Display secrets ONCE -----------------------------------------------------
echo ""
echo -e "${BLD}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLD}║              SAVE THESE CREDENTIALS — SHOWN ONCE                           ║${NC}"
echo -e "${BLD}╠══════════════════════════════════════════════════════════════════════════════╣${NC}"
echo -e "║ ${YEL}POSTGRES_PASSWORD${NC}  : ${POSTGRES_PASSWORD}"
echo -e "║ ${YEL}MINIO_PASSWORD${NC}     : ${MINIO_ROOT_PASSWORD}"
echo -e "║ ${YEL}JWT_SECRET${NC}         : ${JWT_SECRET}"
echo -e "║ ${YEL}WEBHOOK_SECRET${NC}     : ${WEBHOOK_SECRET}"
echo -e "║ ${YEL}TURN_PASSWORD${NC}      : ${TURN_PASSWORD}"
echo -e "║ ${YEL}BACKUP_ENCRYPTION_KEY${NC}: ${BACKUP_ENCRYPTION_KEY}"
echo -e "║ ${YEL}INTERNAL_API_SIGNING_KEY${NC}: ${INTERNAL_API_SIGNING_KEY}"
echo -e "║ ${YEL}CLUSTER_JOIN_TOKEN${NC}  : ${CLUSTER_JOIN_TOKEN}"
echo -e "║ ${YEL}LIVEKIT_API_KEY${NC}    : ${LIVEKIT_API_KEY}"
echo -e "║ ${YEL}LIVEKIT_API_SECRET${NC} : ${LIVEKIT_API_SECRET}"
if [[ -n "$CLOUDFLARE_TURN_KEY_ID" ]]; then
  echo -e "║ ${YEL}CF_TURN_KEY_ID${NC}     : ${CLOUDFLARE_TURN_KEY_ID}"
  echo -e "║ ${YEL}CF_TURN_API_TOKEN${NC}  : ${CLOUDFLARE_TURN_API_TOKEN:0:10}…"
fi
if [[ -n "$VAPID_PUBLIC_KEY" ]]; then
  echo -e "║ ${YEL}VAPID_PUBLIC_KEY${NC}  : ${VAPID_PUBLIC_KEY}"
  echo -e "║ ${YEL}VAPID_PRIVATE_KEY${NC} : ${VAPID_PRIVATE_KEY}"
fi
echo -e "${BLD}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Secrets stored in ${CYN}${SECRETS_DIR}/${NC} and used by Docker."
echo -e "  The secrets directory is in .gitignore — ${BLD}never committed${NC}."
echo -e "  Make an encrypted copy with ${BLD}./start.sh backup-secrets${NC} before first production rollout."
echo ""

touch "$SECRETS_DONE"
echo -e "${GRN}  ✓ Secrets initialized.${NC}"
echo ""
