#!/bin/sh
# =============================================================================
# LiveKit SFU — entrypoint wrapper (Project 13)
# =============================================================================
# LiveKit v1.8 does not expand ${VAR} placeholders inside livekit.yaml, so the
# API key/secret can't live in the config file.  This wrapper reads the values
# from the mounted Docker secrets (preferred) or environment variables
# (dev fallback) and exports them as LIVEKIT_KEYS which LiveKit parses natively.
#
# Contract:
#   * LIVEKIT_API_KEY_FILE     — path to file with the API key.
#   * LIVEKIT_API_SECRET_FILE  — path to file with the API secret.
#   * LIVEKIT_API_KEY / LIVEKIT_API_SECRET — optional plain-env fallback.
#
# Exits early with a descriptive error if neither pair is resolvable so the
# container fails fast instead of starting a useless SFU.
# =============================================================================
set -eu

read_secret() {
  file_var="$1"
  plain_var="$2"
  file_path="$(eval "printf '%s' \"\${${file_var}:-}\"")"
  if [ -n "$file_path" ] && [ -r "$file_path" ]; then
    tr -d '\r\n' < "$file_path"
    return 0
  fi
  plain="$(eval "printf '%s' \"\${${plain_var}:-}\"")"
  if [ -n "$plain" ]; then
    printf '%s' "$plain"
    return 0
  fi
  return 1
}

LIVEKIT_API_KEY_VAL="$(read_secret LIVEKIT_API_KEY_FILE LIVEKIT_API_KEY || true)"
LIVEKIT_API_SECRET_VAL="$(read_secret LIVEKIT_API_SECRET_FILE LIVEKIT_API_SECRET || true)"

# Graceful "unconfigured" mode: when the operator has not yet generated
# LiveKit keys (empty or missing secret files), do NOT restart-loop — park
# the container in an idle sleep so compose reports it as Up but it never
# tries to read tokens.  Operator can later `echo "key" > secrets/livekit_api_key`
# (and the secret_stub in start.sh) and `docker restart forestmessenger-livekit-1`
# to bring the SFU online.  The messenger itself falls back to coturn or
# Cloudflare Calls TURN for 1-to-1 calls in this mode.
if [ -z "${LIVEKIT_API_KEY_VAL}" ] || [ -z "${LIVEKIT_API_SECRET_VAL}" ]; then
  echo "[livekit-entrypoint] LiveKit keys not configured — parking container in idle mode." >&2
  echo "[livekit-entrypoint] To enable the SFU: write your key to secrets/livekit_api_key," >&2
  echo "[livekit-entrypoint] your 32+ char secret to secrets/livekit_api_secret, then" >&2
  echo "[livekit-entrypoint] \`docker restart forestmessenger-livekit-1\`." >&2
  exec sleep infinity
fi

if [ "${#LIVEKIT_API_SECRET_VAL}" -lt 32 ] 2>/dev/null; then
  # POSIX sh does not support ${#var}-style length in all shells — tolerate
  # the comparison failing and fall through; we still log a hint.
  echo "[livekit-entrypoint] WARN: LIVEKIT_API_SECRET is shorter than 32 chars; token validation will fail on the API side." >&2
fi

export LIVEKIT_KEYS="${LIVEKIT_API_KEY_VAL}: ${LIVEKIT_API_SECRET_VAL}"

unset LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_API_KEY_VAL LIVEKIT_API_SECRET_VAL

exec /livekit-server "$@"
