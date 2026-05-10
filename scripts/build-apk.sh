#!/usr/bin/env bash
# Build OneToThree Android APK (debug or release).
#
# Usage:
#   ./scripts/build-apk.sh                     # debug APK
#   ./scripts/build-apk.sh release             # release APK (needs keystore)
#   ./scripts/build-apk.sh release <keystore>  # release with explicit keystore path
#
# Prerequisites (native build):
#   - Java 17+ in PATH (or JAVA_HOME set)
#   - Node 20+ in PATH
#   - Android SDK (ANDROID_HOME or ANDROID_SDK_ROOT)
#
# If ANDROID_HOME / ANDROID_SDK_ROOT are NOT set the script automatically falls
# back to a Docker-based build using the onetothree-android-builder image.
# The image is built once (cached) from docker/android-builder/Dockerfile.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_DIR="$ROOT/client"
CAP_DIR="$ROOT/mobile/capacitor"
ANDROID_DIR="$CAP_DIR/android"
ENV_FILE="$ROOT/.env.prod"
BUILDER_IMG="onetothree-android-builder:latest"

BUILD_TYPE="${1:-debug}"

# -- helpers --
log()  { printf '\033[0;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

val_for_key() {
  grep "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '\r'
}

# -- read runtime config from .env.prod --
[[ -f "$ENV_FILE" ]] || die ".env.prod not found — run ./startup.sh first."
API_URL="$(val_for_key NEXT_PUBLIC_API_URL)"
APP_URL="$(val_for_key NEXT_PUBLIC_APP_URL)"
VAPID_KEY="$(val_for_key NEXT_PUBLIC_VAPID_PUBLIC_KEY)"
TURN_URLS="$(val_for_key NEXT_PUBLIC_TURN_URLS)"
TURN_USER="$(val_for_key NEXT_PUBLIC_TURN_USERNAME)"
TURN_PASS="$(val_for_key NEXT_PUBLIC_TURN_PASSWORD)"
[[ -n "$API_URL" ]] || die "NEXT_PUBLIC_API_URL missing in .env.prod"

log "API URL  : $API_URL"
log "Build    : $BUILD_TYPE APK"

# =============================================================================
# DOCKER-BASED BUILD  (when Android SDK is not installed locally)
# =============================================================================
if [[ -z "${ANDROID_HOME:-}" ]] && [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  command -v docker >/dev/null 2>&1 || die "Docker not found. Install Docker or set ANDROID_HOME."

  if ! docker image inspect "$BUILDER_IMG" >/dev/null 2>&1; then
    log "Building Android builder image (first time — ~10 min)…"
    docker build -t "$BUILDER_IMG" "$ROOT/docker/android-builder/"
    ok "Builder image ready: $BUILDER_IMG"
  else
    ok "Using cached builder image: $BUILDER_IMG"
  fi

  DOCKER_ENV=(
    -e BUILD_TYPE="$BUILD_TYPE"
    -e NEXT_PUBLIC_API_URL="$API_URL"
    -e NEXT_PUBLIC_APP_URL="${APP_URL:-$API_URL}"
    -e NEXT_PUBLIC_WS_ORIGIN="${API_URL}"
    -e NEXT_PUBLIC_VAPID_PUBLIC_KEY="${VAPID_KEY:-}"
    -e NEXT_PUBLIC_TURN_URLS="${TURN_URLS:-}"
    -e NEXT_PUBLIC_TURN_USERNAME="${TURN_USER:-}"
    -e NEXT_PUBLIC_TURN_PASSWORD="${TURN_PASS:-}"
  )

  KS_MOUNT=()
  if [[ "$BUILD_TYPE" == "release" ]]; then
    KEYSTORE="${2:-}"
    [[ -n "$KEYSTORE" && -f "$KEYSTORE" ]] || die "Release build: ./scripts/build-apk.sh release <keystore.jks>"
    DOCKER_ENV+=(
      -e RELEASE_STORE_FILE="/keystore/$(basename "$KEYSTORE")"
      -e RELEASE_STORE_PASSWORD="${RELEASE_STORE_PASSWORD:-}"
      -e RELEASE_KEY_ALIAS="${RELEASE_KEY_ALIAS:-p13release}"
      -e RELEASE_KEY_PASSWORD="${RELEASE_KEY_PASSWORD:-${RELEASE_STORE_PASSWORD:-}}"
    )
    KS_MOUNT=(-v "$(dirname "$(realpath "$KEYSTORE")"):/keystore:ro")
  fi

  log "Running build inside Docker container…"
  docker run --rm \
    -v "$ROOT:/workspace" \
    "${KS_MOUNT[@]}" \
    "${DOCKER_ENV[@]}" \
    "$BUILDER_IMG" \
    bash /workspace/scripts/build-apk-inner.sh

  APK_OUT="$ROOT/releases/android/onetothree-${BUILD_TYPE}.apk"
  [[ -f "$APK_OUT" ]] && ok "Done — APK: releases/android/onetothree-${BUILD_TYPE}.apk" || die "APK not found after build."
  exit 0
fi

# =============================================================================
# NATIVE BUILD  (Android SDK available on the host)
# =============================================================================
command -v java >/dev/null 2>&1 || die "Java not found. Install JDK 17+ and set JAVA_HOME."
command -v node >/dev/null 2>&1 || die "Node.js not found."
command -v npx  >/dev/null 2>&1 || die "npx not found."

# 1. Next.js static export
log "Step 1/3: Next.js static export…"
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

# 2. Capacitor sync
log "Step 2/3: Capacitor sync…"
cd "$CAP_DIR"
npx cap sync android --no-build 2>&1 | tail -5
ok "Capacitor sync complete."

# 3. Gradle build
log "Step 3/3: Gradle ${BUILD_TYPE} build…"
cd "$ANDROID_DIR"
chmod +x ./gradlew

if [[ "$BUILD_TYPE" == "release" ]]; then
  KEYSTORE="${2:-}"
  KS_PASS="${RELEASE_STORE_PASSWORD:-}"
  KS_ALIAS="${RELEASE_KEY_ALIAS:-p13release}"
  KS_KEY_PASS="${RELEASE_KEY_PASSWORD:-$KS_PASS}"
  [[ -n "$KEYSTORE" && -f "$KEYSTORE" ]] || die "Release: ./scripts/build-apk.sh release <keystore.jks>"
  ./gradlew assembleRelease \
    -PRELEASE_STORE_FILE="$KEYSTORE" \
    -PRELEASE_STORE_PASSWORD="$KS_PASS" \
    -PRELEASE_KEY_ALIAS="$KS_ALIAS" \
    -PRELEASE_KEY_PASSWORD="$KS_KEY_PASS"
  APK_PATH="app/build/outputs/apk/release/app-release.apk"
else
  ./gradlew assembleDebug
  APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
fi

[[ -f "$APK_PATH" ]] || die "APK not found at $APK_PATH"
RELEASES_DIR="$ROOT/releases/android"
mkdir -p "$RELEASES_DIR"
cp "$APK_PATH" "$RELEASES_DIR/onetothree-${BUILD_TYPE}.apk"
ok "APK ready: releases/android/onetothree-${BUILD_TYPE}.apk"
