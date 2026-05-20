#!/usr/bin/env bash
# Runs INSIDE the onetothree-android-builder Docker container.
# Called by build-apk.sh when ANDROID_HOME is not available on the host.
#
# Env vars expected (set by build-apk.sh via docker run -e):
#   BUILD_TYPE, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_WS_ORIGIN,
#   NEXT_PUBLIC_VAPID_PUBLIC_KEY, NEXT_PUBLIC_TURN_URLS, NEXT_PUBLIC_TURN_USERNAME,
#   NEXT_PUBLIC_TURN_PASSWORD
set -euo pipefail

ROOT="/workspace"
CLIENT_DIR="$ROOT/client"
CAP_DIR="$ROOT/mobile/capacitor"
ANDROID_DIR="$CAP_DIR/android"
BUILD_TYPE="${BUILD_TYPE:-debug}"

log()  { printf '\033[0;34m[docker] ▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m[docker] ✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m[docker] ✗ %s\033[0m\n' "$*" >&2; exit 1; }

copy_apk_artifacts() {
  local source_apk="$1"
  local kind="$2"
  local releases_dir="$ROOT/releases/android"
  local stable_name="${APK_OUTPUT_NAME:-onetothree-${kind}.apk}"
  [[ "$stable_name" == *.apk ]] || stable_name="${stable_name}.apk"

  mkdir -p "$releases_dir"
  cp "$source_apk" "$releases_dir/$stable_name"
  sha256sum "$releases_dir/$stable_name" > "$releases_dir/$stable_name.sha256"

  if [[ "${APK_NO_VERSIONED_COPY:-0}" != "1" ]]; then
    local stamp sha versioned_name
    stamp="$(date +%Y%m%d-%H%M)"
    sha="$(git -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || printf 'nogit')"
    versioned_name="onetothree-${kind}-${stamp}-${sha}.apk"
    cp "$source_apk" "$releases_dir/$versioned_name"
    sha256sum "$releases_dir/$versioned_name" > "$releases_dir/$versioned_name.sha256"
    ok "APK ready: releases/android/$versioned_name"
    ok "SHA256 : releases/android/$versioned_name.sha256"
  fi

  ok "APK ready: releases/android/$stable_name"
  ok "SHA256 : releases/android/$stable_name.sha256"
}

# ── 1. Client deps ─────────────────────────────────────────────────────────
log "Installing client dependencies…"
cd "$CLIENT_DIR"
npm ci --no-audit --no-fund --prefer-offline 2>&1 | tail -3

# ── 2. Next.js static export ───────────────────────────────────────────────
# Wipe any prior export first so stale pages (e.g. a route removed in a later
# commit) can never be packaged into the APK.
log "Cleaning previous Next.js export (client/out, client/.next)…"
rm -rf "$CLIENT_DIR/out" "$CLIENT_DIR/.next"
log "Building Next.js static export (output: client/out)…"
env \
  NEXT_EXPORT=1 \
  NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL}" \
  NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-${NEXT_PUBLIC_API_URL}}" \
  NEXT_PUBLIC_WS_ORIGIN="${NEXT_PUBLIC_WS_ORIGIN:-${NEXT_PUBLIC_API_URL}}" \
  NEXT_PUBLIC_VAPID_PUBLIC_KEY="${NEXT_PUBLIC_VAPID_PUBLIC_KEY:-}" \
  NEXT_PUBLIC_TURN_URLS="${NEXT_PUBLIC_TURN_URLS:-}" \
  NEXT_PUBLIC_TURN_USERNAME="${NEXT_PUBLIC_TURN_USERNAME:-}" \
  NEXT_PUBLIC_TURN_PASSWORD="${NEXT_PUBLIC_TURN_PASSWORD:-}" \
  npx next build --webpack
ok "Next.js export complete → client/out/"

# ── 3. Capacitor deps ─────────────────────────────────────────────────────
log "Installing Capacitor dependencies…"
cd "$CAP_DIR"
npm ci --no-audit --no-fund --prefer-offline 2>&1 | tail -3

# ── 4. Capacitor sync ─────────────────────────────────────────────────────
log "Capacitor sync → android…"
npx cap sync android --no-build 2>&1 | tail -5
ok "Capacitor sync complete."

# ── 5. Gradle build ───────────────────────────────────────────────────────
log "Running Gradle ${BUILD_TYPE} build…"
cd "$ANDROID_DIR"
chmod +x ./gradlew

if [[ "$BUILD_TYPE" == "release" ]]; then
  KEYSTORE="${RELEASE_STORE_FILE:-}"
  KS_PASS="${RELEASE_STORE_PASSWORD:-}"
  KS_ALIAS="${RELEASE_KEY_ALIAS:-p13release}"
  KS_KEY_PASS="${RELEASE_KEY_PASSWORD:-${KS_PASS}}"
  [[ -n "$KEYSTORE" && -f "$KEYSTORE" ]] || die "Release build: set RELEASE_STORE_FILE, RELEASE_STORE_PASSWORD, RELEASE_KEY_ALIAS"
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

# ── 6. Copy to releases/ ──────────────────────────────────────────────────
[[ -f "$APK_PATH" ]] || die "APK not found at $APK_PATH"
copy_apk_artifacts "$APK_PATH" "$BUILD_TYPE"
