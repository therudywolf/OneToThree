#!/usr/bin/env bash
# Build the OneToThree iOS app (Capacitor) — MUST run on macOS.
#
# Mirrors scripts/build-apk.sh but targets iOS. It performs the Next.js static
# export, syncs the Capacitor iOS project, and (optionally) archives a signed
# .ipa via xcodebuild. Without a signing team it just opens Xcode so you can
# archive manually (Product ▸ Archive).
#
# Usage:
#   ./scripts/build-ipa.sh                       # web+sync, then open Xcode for manual archive
#   ./scripts/build-ipa.sh archive               # archive with auto-signing (needs IOS_DEVELOPMENT_TEAM)
#   ./scripts/build-ipa.sh simulator             # build for the iOS Simulator (no signing required)
#
# Environment:
#   IOS_DEVELOPMENT_TEAM   Apple Developer Team ID (10 chars, e.g. A1B2C3D4E5). Required for `archive`.
#   IOS_EXPORT_METHOD      development | ad-hoc | app-store | enterprise  (default: development)
#
# Prerequisites (see docs/BUILD_MACOS_IOS.md):
#   - macOS + Xcode (full, from the App Store) + Command Line Tools
#   - CocoaPods         (sudo gem install cocoapods   OR   brew install cocoapods)
#   - Node 20+, npm
#   - An Apple Developer account for on-device / store builds
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_DIR="$ROOT/client"
CAP_DIR="$ROOT/mobile/capacitor"
IOS_DIR="$CAP_DIR/ios"
APP_DIR="$IOS_DIR/App"
ENV_FILE="$ROOT/.env.prod"

MODE="${1:-open}"   # open | archive | simulator
EXPORT_METHOD="${IOS_EXPORT_METHOD:-development}"

log()  { printf '\033[0;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Shared reader: strips CR, quotes and an inline `# comment` — see the APK
# script for the failure this fixes (the comment ended up inside the API URL).
# shellcheck source=lib/env-value.sh
source "$ROOT/scripts/lib/env-value.sh"
val_for_key() { env_value "$1" "$ENV_FILE"; }

# -- platform / tooling guards --------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "iOS builds require macOS. This host is $(uname -s)."
command -v node    >/dev/null 2>&1 || die "Node.js not found."
command -v npx     >/dev/null 2>&1 || die "npx not found."
command -v xcodebuild >/dev/null 2>&1 || die "Xcode not found. Install Xcode from the App Store, then: xcode-select --install"
command -v pod     >/dev/null 2>&1 || die "CocoaPods not found. Install: sudo gem install cocoapods  (or brew install cocoapods)"

# -- runtime config -------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || die ".env.prod not found — create it (see docs/BUILD_MACOS_IOS.md) or run ./startup.sh."
API_URL="$(val_for_key NEXT_PUBLIC_API_URL)"
APP_URL="$(val_for_key NEXT_PUBLIC_APP_URL)"
VAPID_KEY="$(val_for_key NEXT_PUBLIC_VAPID_PUBLIC_KEY)"
TURN_URLS="$(val_for_key NEXT_PUBLIC_TURN_URLS)"
TURN_USER="$(val_for_key NEXT_PUBLIC_TURN_USERNAME)"
TURN_PASS="$(val_for_key NEXT_PUBLIC_TURN_PASSWORD)"
[[ -n "$API_URL" ]] || die "NEXT_PUBLIC_API_URL missing in .env.prod"

log "API URL : $API_URL"
log "Mode    : $MODE"

# 1. Next.js static export (identical config to the Android build) --------------
log "Step 1/4: Next.js static export…"
cd "$CLIENT_DIR"
rm -rf "$CLIENT_DIR/out" "$CLIENT_DIR/.next"
env \
  NEXT_EXPORT=1 \
  NEXT_PUBLIC_API_URL="$API_URL" \
  NEXT_PUBLIC_APP_URL="${APP_URL:-}" \
  NEXT_PUBLIC_WS_ORIGIN="$API_URL" \
  NEXT_PUBLIC_VAPID_PUBLIC_KEY="${VAPID_KEY:-}" \
  NEXT_PUBLIC_TURN_URLS="${TURN_URLS:-}" \
  NEXT_PUBLIC_TURN_USERNAME="${TURN_USER:-}" \
  NEXT_PUBLIC_TURN_PASSWORD="${TURN_PASS:-}" \
  npx next build --webpack
ok "Next.js export complete → client/out/"

# 2. Add the iOS platform on first run, then sync -------------------------------
cd "$CAP_DIR"
if [[ ! -d "$IOS_DIR" ]]; then
  log "Step 2/4: iOS platform not present — running 'cap add ios'…"
  npx cap add ios
else
  log "Step 2/4: Capacitor sync ios…"
  npx cap sync ios
fi
ok "Capacitor iOS project ready at mobile/capacitor/ios/"

# 3. Pods (cap sync already runs pod install, but be explicit/robust) -----------
log "Step 3/4: CocoaPods install…"
( cd "$APP_DIR" && pod install )
ok "Pods installed."

# 4. Build --------------------------------------------------------------------
cd "$APP_DIR"
case "$MODE" in
  simulator)
    log "Step 4/4: building for iOS Simulator (no signing)…"
    xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
      -sdk iphonesimulator -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
    ok "Simulator build complete → mobile/capacitor/ios/App/build/Build/Products/Release-iphonesimulator/App.app"
    ;;
  archive)
    [[ -n "${IOS_DEVELOPMENT_TEAM:-}" ]] || die "archive mode needs IOS_DEVELOPMENT_TEAM=<10-char Apple Team ID>"
    OUT="$ROOT/releases/ios"; mkdir -p "$OUT"
    ARCHIVE="$OUT/App.xcarchive"
    log "Step 4/4: xcodebuild archive (team $IOS_DEVELOPMENT_TEAM, method $EXPORT_METHOD)…"
    xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
      -sdk iphoneos -archivePath "$ARCHIVE" \
      DEVELOPMENT_TEAM="$IOS_DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic archive
    cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>${EXPORT_METHOD}</string>
  <key>teamID</key><string>${IOS_DEVELOPMENT_TEAM}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>stripSwiftSymbols</key><true/>
  <key>compileBitcode</key><false/>
</dict></plist>
PLIST
    log "Exporting .ipa…"
    xcodebuild -exportArchive -archivePath "$ARCHIVE" \
      -exportPath "$OUT/ipa" -exportOptionsPlist "$OUT/ExportOptions.plist"
    ok "IPA exported → releases/ios/ipa/"
    ls -1 "$OUT/ipa"/*.ipa 2>/dev/null || true
    ;;
  open|*)
    log "Step 4/4: opening Xcode — set the signing team, then Product ▸ Archive."
    npx cap open ios
    ok "Xcode opened. Manual archive: select 'Any iOS Device', Product ▸ Archive ▸ Distribute App."
    ;;
esac
