#!/usr/bin/env bash
# OneToThree Lite — guided installer (Linux / macOS).
# Run from a repo checkout:  bash scripts/lite/install.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v docker >/dev/null 2>&1 || { echo "[!] Docker is required — https://docs.docker.com/get-docker/"; exit 1; }
command -v node   >/dev/null 2>&1 || { echo "[!] Node.js 18+ is required — https://nodejs.org/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "[!] Docker Compose v2 is required (docker compose)."; exit 1; }

exec node scripts/lite/install.mjs
