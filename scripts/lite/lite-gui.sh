#!/usr/bin/env bash
# OneToThree Lite — launch the graphical setup wizard (macOS / Linux).
#   ./scripts/lite/lite-gui.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v node >/dev/null 2>&1 || { echo "Node.js is required (https://nodejs.org)"; exit 1; }
if ! command -v docker >/dev/null 2>&1; then
  echo "⚠ Docker not found — the wizard opens, but you'll need Docker Desktop to launch the stack."
elif ! docker compose version >/dev/null 2>&1; then
  echo "⚠ Docker Compose v2 not found — install/upgrade Docker Desktop."
fi

exec node scripts/lite/wizard/server.mjs "$@"
