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

# sha256, portably and WITHOUT the build machine's absolute path.
#
# `sha256sum /abs/path/file.apk > file.apk.sha256` writes the absolute path into
# the sidecar, so `sha256sum -c` on the downloader's machine looks for a
# directory that does not exist — and the build host's path ends up published in
# the release. macOS has no `sha256sum` at all, so the native build died here
# with the APK already sitting on disk.
sha256_sidecar() {
  local file="$1" dir base
  dir="$(dirname "$file")"
  base="$(basename "$file")"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && sha256sum "$base" > "$base.sha256")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$dir" && shasum -a 256 "$base" > "$base.sha256")
  else
    die "no sha256sum or shasum available to checksum $base"
  fi
}

copy_apk_artifacts() {
  local source_apk="$1"
  local kind="$2"
  local releases_dir="$ROOT/releases/android"
  local stable_name="${APK_OUTPUT_NAME:-onetothree-${kind}.apk}"
  [[ "$stable_name" == *.apk ]] || stable_name="${stable_name}.apk"

  mkdir -p "$releases_dir"
  cp "$source_apk" "$releases_dir/$stable_name"
  sha256_sidecar "$releases_dir/$stable_name"

  if [[ "${APK_NO_VERSIONED_COPY:-0}" != "1" ]]; then
    local stamp sha versioned_name
    stamp="$(date +%Y%m%d-%H%M)"
    # -c safe.directory: the container runs as root over a bind-mounted repo
    # owned by another uid, and git refuses "dubious ownership" — which turned
    # every containerised build's artifact name into onetothree-debug-…-nogit.
    sha="$(git -c safe.directory='*' -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || printf 'nogit')"
    versioned_name="onetothree-${kind}-${stamp}-${sha}.apk"
    cp "$source_apk" "$releases_dir/$versioned_name"
    sha256_sidecar "$releases_dir/$versioned_name"
    ok "APK ready: releases/android/$versioned_name"
    ok "SHA256 : releases/android/$versioned_name.sha256"
  fi

  ok "APK ready: releases/android/$stable_name"
  ok "SHA256 : releases/android/$stable_name.sha256"
}

# ── 1. Client deps ─────────────────────────────────────────────────────────
# Installed from the REPO ROOT: `client` is an npm workspace and has no lockfile
# of its own in a fresh clone, so `npm ci` inside client/ aborted with "can only
# install with an existing package-lock.json". The root lockfile is the tracked
# one, and it covers the client and server workspaces in a single pass.
log "Installing workspace dependencies (root lockfile)…"
cd "$ROOT"
npm ci --no-audit --no-fund --prefer-offline 2>&1 | tail -3

# ── 2. Next.js static export ───────────────────────────────────────────────
# Wipe any prior export first so stale pages (e.g. a route removed in a later
# commit) can never be packaged into the APK.
log "Cleaning previous Next.js export (client/out, client/.next)…"
rm -rf "$CLIENT_DIR/out" "$CLIENT_DIR/.next"
log "Building Next.js static export (output: client/out)…"
# Through the repo's own entry point, from the ROOT: it runs the export inside
# the client workspace (so Next finds app/) and fills in the public-instance
# defaults for anything unset. Calling `npx next build` here instead relied on
# the previous step having left the shell inside client/.
cd "$ROOT"
env \
  NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL}" \
  NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-}" \
  NEXT_PUBLIC_WS_ORIGIN="${NEXT_PUBLIC_WS_ORIGIN:-${NEXT_PUBLIC_API_URL}}" \
  NEXT_PUBLIC_VAPID_PUBLIC_KEY="${NEXT_PUBLIC_VAPID_PUBLIC_KEY:-}" \
  NEXT_PUBLIC_TURN_URLS="${NEXT_PUBLIC_TURN_URLS:-}" \
  NEXT_PUBLIC_TURN_USERNAME="${NEXT_PUBLIC_TURN_USERNAME:-}" \
  NEXT_PUBLIC_TURN_PASSWORD="${NEXT_PUBLIC_TURN_PASSWORD:-}" \
  npm run build:client:export
ok "Next.js export complete → client/out/"

# ── 3. Capacitor deps ─────────────────────────────────────────────────────
# mobile/capacitor/package-lock.json is deliberately gitignored (.gitignore:157),
# so `npm ci` here could never succeed — it requires a lockfile. Use it only if
# one happens to exist locally; otherwise install from package.json.
log "Installing Capacitor dependencies…"
cd "$CAP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund --prefer-offline 2>&1 | tail -3
else
  npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -3
fi

# ── 4. Capacitor sync ─────────────────────────────────────────────────────
log "Capacitor sync → android…"
# `cap sync` accepts only --deployment / --inline. The --no-build that used to
# be here is not a known option, and with `set -o pipefail` the unknown-option
# exit killed the container build before Gradle ever started.
npx cap sync android 2>&1 | tail -5
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
