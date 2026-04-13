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
TURN_PASSWORD=$(openssl rand -hex 16)

# --- Manual inputs ------------------------------------------------------------
echo ""
echo -e "${BLD}  Configure your deployment:${NC}"
echo ""
read -rp "  Enter your domain (e.g. onetothree.ru): " DOMAIN
read -rp "  Enter ACME email for TLS certs: " ACME_EMAIL
read -rp "  Enter TURN server external IP (curl -s ifconfig.me): " TURN_EXTERNAL_IP
read -rp "  Enter VAPID contact email (e.g. admin@onetothree.ru): " VAPID_SUBJECT

CORS_ORIGIN="https://${DOMAIN}"

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
    VAPID_JSON=$(docker run --rm node:20-alpine sh -c \
      'npm install -g web-push --silent 2>/dev/null && web-push generate-vapid-keys --json 2>/dev/null' 2>/dev/null || true)
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
echo -n "$TURN_PASSWORD"        > "$SECRETS_DIR/turn_password"
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
if [[ -n "$VAPID_PUBLIC_KEY" ]]; then
  echo -e "║ ${YEL}VAPID_PUBLIC_KEY${NC}  : ${VAPID_PUBLIC_KEY}"
  echo -e "║ ${YEL}VAPID_PRIVATE_KEY${NC} : ${VAPID_PRIVATE_KEY}"
fi
echo -e "${BLD}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Secrets stored in ${CYN}${SECRETS_DIR}/${NC} and used by Docker."
echo -e "  The secrets directory is in .gitignore — ${BLD}never committed${NC}."
echo ""

touch "$SECRETS_DONE"
echo -e "${GRN}  ✓ Secrets initialized.${NC}"
echo ""
