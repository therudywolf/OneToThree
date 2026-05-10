#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$ROOT/scripts/start.mjs" "$@"
fi
if [[ -x "/mnt/c/Program Files/nodejs/node.exe" ]]; then
  exec "/mnt/c/Program Files/nodejs/node.exe" "$ROOT/scripts/start.mjs" "$@"
fi
echo "node is required. Install Node.js >=20.9.0 or add it to PATH." >&2
exit 127
