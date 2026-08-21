#!/usr/bin/env bash
# OneToThree Lite — guided installer (Linux / macOS).
#
#   bash scripts/lite/install.sh
#
# macOS: scripts/lite/install.command runs this from a double-click in Finder.
#
# This wrapper only checks prerequisites and hands over to the Node installer.
# It exists so that a missing prerequisite produces a link instead of a stack
# trace — and so the link is the right one for THIS operating system, which is
# the difference between installing Docker and reading about Docker.
set -euo pipefail
cd "$(dirname "$0")/../.."

red()  { printf '\033[31m%s\033[39m\n' "$1"; }
dim()  { printf '\033[2m%s\033[22m\n' "$1"; }

docker_link() {
  case "$(uname -s)" in
    Darwin) echo 'https://docs.docker.com/desktop/install/mac-install/' ;;
    *)      echo 'https://docs.docker.com/engine/install/' ;;
  esac
}

fail() {
  echo
  red "  [x] $1"
  dim  "      $2"
  echo
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'Docker is required.' "$(docker_link)"
command -v node   >/dev/null 2>&1 || fail 'Node.js 18+ is required.' 'https://nodejs.org/  (choose the LTS build)'
docker compose version >/dev/null 2>&1 ||
  fail 'Docker Compose v2 is required.' 'It ships with Docker Desktop; on Linux install the docker-compose-plugin package.'

# `docker --version` answers from the CLI binary alone. The daemon not running
# is the most common reason an install fails, and finding out at the END — after
# every question has been answered — is the worst possible time. The Node
# installer checks this too; catching it here keeps the message short.
if ! docker info >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin) fail 'The Docker daemon is not responding.' 'Start Docker Desktop and try again.' ;;
    *)      fail 'The Docker daemon is not responding.' 'Try: sudo systemctl start docker   (or start Docker Desktop)' ;;
  esac
fi

exec node scripts/lite/install.mjs
