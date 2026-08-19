#!/usr/bin/env bash
# Read one value out of a KEY=VALUE env file — the single implementation.
#
# The build scripts used to carry their own one-liner
# (`grep "^KEY=" | cut -d= -f2- | tr -d '\r'`), which keeps everything after the
# `=`: surrounding quotes, trailing spaces, and — the one that actually bit —
# an inline `# comment`. config/env/.env.prod.example ships exactly such
# comments, so `NEXT_PUBLIC_API_URL=https://api.example.com   # set by domain`
# was baked into the APK verbatim as the API origin. Every request in the built
# app then went to an unparseable URL, and nothing in the build said a word.
#
# Usage:
#   source "$ROOT/scripts/lib/env-value.sh"
#   API_URL="$(env_value NEXT_PUBLIC_API_URL "$ENV_FILE")"

# shellcheck disable=SC2034
env_value() {
  local key="$1"
  local file="${2:-${ENV_FILE:-}}"
  local line val
  line=$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -n1 || true)
  [[ -z "$line" ]] && { printf ''; return; }
  val="${line#*=}"
  val="${val//$'\r'/}"
  # trim, unquote, drop an inline comment, trim again
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ "$val" == \"*\" ]]; then
    val="${val#\"}"
    val="${val%\"}"
  elif [[ "$val" == \'*\' ]]; then
    val="${val#\'}"
    val="${val%\'}"
  else
    val="${val%%#*}"
    val="${val%"${val##*[![:space:]]}"}"
  fi
  printf '%s' "$val"
}
