#!/usr/bin/env bash
# Build OneToThree Android APK (debug or release).
#
# Usage:
#   ./scripts/build-apk.sh                     # debug APK
#   ./scripts/build-apk.sh release             # release APK (needs keystore)
#   ./scripts/build-apk.sh release <keystore>  # release with explicit keystore path
#
# Prerequisites:
#   - Java 17+ in PATH (or JAVA_HOME set)
#   - Node 20+ in PATH
#   - Android SDK (ANDROID_HOME or ANDROID_SDK_ROOT)
#   - run from repo root
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_DIR="$ROOT/client"
CAP_DIR="$ROOT/mobile/capacitor"
ANDROID_DIR="$CAP_DIR/android"
ENV_FILE="$ROOT/.env.prod"

BUILD_TYPE="${1:-debug}"

# ── helpers ──────────────────────────────────────────────────────────────────
log()  { printf '\033[0;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

val_for_key() {
  local key="$1"
  grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '\r'
}

# ── check prerequisites ───────────────────────────────────────────────────────
command -v java  >/dev/null 2>&1 || die "Java not found. Install JDK 17+ and set JAVA_HOME."
command -v node  >/dev/null 2>&1 || die "Node.js not found."
command -v npx   >/dev/null 2>&1 || die "npx not found."

if [[ -z "${ANDROID_HOME:-}" ]] && [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  die "ANDROID_HOME or ANDROID_SDK_ROOT must be set."
fi

# ── read API URL from .env.prod ───────────────────────────────────────────────
API_URL="$(val_for_key NEXT_PUBLIC_API_URL)"
APP_URL="$(val_for_key NEXT_PUBLIC_APP_URL)"
VAPID_KEY="$(val_for_key NEXT_PUBLIC_VAPID_PUBLIC_KEY)"
TURN_URLS="$(val_for_key NEXT_PUBLIC_TURN_URLS)"
TURN_USER="$(val_for_key NEXT_PUBLIC_TURN_USERNAME)"
TURN_PASS="$(val_for_key NEXT_PUBLIC_TURN_PASSWORD)"

[[ -n "$API_URL" ]] || die "NEXT_PUBLIC_API_URL missing in .env.prod — run ./start.sh first."

log "API URL: $API_URL"
log "Building $BUILD_TYPE APK..."

# ── 1. Next.js static export ──────────────────────────────────────────────────
log "Step 1/3: Next.js export..."
cd "$CLIENT_DIR"
env \
  NEXT_EXPORT=1 \
  NEXT_PUBLIC_API_URL="$API_URL" \
  NEXT_PUBLIC_APP_URL="${APP_URL:-$API_URL}" \
  NEXT_PUBLIC_WS_ORIGIN="$API_URL" \
  NEXT_PUBLIC_VAPID_PUBLIC_KEY="${VAPID_KEY:-}" \
  NEXT_PUBLIC_TURN_URLS="${TURN_URLS:-}" \
  NEXT_PUBLIC_TURN_USERNAME="${TURN_USER:-}" \
  NEXT_PUBLIC_TURN_PASSWORD="${TURN_PASS:-}" \
  npx next build --webpack
ok "Next.js export complete → client/out/"

# ── 2. Capacitor sync ────────────────────────────────────────────────────────
log "Step 2/3: Capacitor sync..."
cd "$CAP_DIR"
npx cap sync android --no-build 2>&1 | tail -5
ok "Capacitor sync complete."

# ── 3. Gradle build ──────────────────────────────────────────────────────────
log "Step 3/3: Gradle assembleDebug..."
cd "$ANDROID_DIR"

GRADLE_ARGS=()
if [[ "$BUILD_TYPE" == "release" ]]; then
  KEYSTORE="${2:-}"
  KS_PASS="${RELEASE_STORE_PASSWORD:-}"
  KS_ALIAS="${RELEASE_KEY_ALIAS:-p13release}"
  KS_KEY_PASS="${RELEASE_KEY_PASSWORD:-$KS_PASS}"

  if [[ -n "$KEYSTORE" ]] && [[ -f "$KEYSTORE" ]]; then
    GRADLE_ARGS+=(
      -PRELEASE_STORE_FILE="$KEYSTORE"
      -PRELEASE_STORE_PASSWORD="$KS_PASS"
      -PRELEASE_KEY_ALIAS="$KS_ALIAS"
      -PRELEASE_KEY_PASSWORD="$KS_KEY_PASS"
    )
    ./gradlew assembleRelease "${GRADLE_ARGS[@]}"
    APK_PATH="app/build/outputs/apk/release/app-release.apk"
  else
    die "Release build requires: ./scripts/build-apk.sh release <path-to-keystore.jks>
Also set: RELEASE_STORE_PASSWORD, RELEASE_KEY_ALIAS, RELEASE_KEY_PASSWORD env vars."
  fi
else
  ./gradlew assembleDebug
  APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
fi

if [[ -f "$APK_PATH" ]]; then
  DEST="$ROOT/onetothree-${BUILD_TYPE}.apk"
  cp "$APK_PATH" "$DEST"
  ok "APK ready: $DEST"
else
  die "APK not found at $APK_PATH"
fi
