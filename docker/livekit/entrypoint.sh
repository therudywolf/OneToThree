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
# (and the secret_stub in startup.sh) and `docker restart forestmessenger-livekit-1`
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

# Pin the advertised ICE IP to the public address. Under host networking LiveKit
# otherwise enumerates every interface (all docker bridges) and advertises bogus
# 172.x/192.168.x candidates that slow or break ICE. Reuse TURN_EXTERNAL_IP (the
# same public IP coturn uses); LIVEKIT_NODE_IP overrides if ever needed. Keeping
# the IP out of the YAML keeps the config portable across deployments.
NODE_IP_VAL="${LIVEKIT_NODE_IP:-${TURN_EXTERNAL_IP:-}}"

# ---------------------------------------------------------------------------
# Keep the PLAINTEXT signaling port off the public interface.
#
# 7880 is HTTP/WS: reached directly it carries the room JWT in the clear and
# exposes /twirp/livekit.RoomService/* outside Caddy — no TLS, no Anubis
# proof-of-work, no CrowdSec rate limiting on an auth endpoint. The YAML said
# the host firewall "MUST keep 7880 closed"; it did not — a probe from the
# internet answered 200 — so relying on that alone was not good enough.
#
# It cannot be pinned to 127.0.0.1: the reverse proxy runs in its own container
# and dials host.docker.internal:7880, which resolves to the DOCKER BRIDGE
# GATEWAY, not loopback. So bind exactly that gateway (plus loopback for local
# probes), discovered at runtime rather than hard-coded, because docker0 can be
# renumbered. If discovery fails we leave LiveKit's own default alone — a
# non-starting SFU would be worse than the exposure we are closing.
#
# Media is unaffected: UDP 50000 and TCP 7881 keep their own binding and MUST
# stay open to the internet.
# ---------------------------------------------------------------------------
BRIDGE_GW="$(ip -4 route show default 0.0.0.0/0 dev docker0 2>/dev/null | awk '{print $NF}' | head -n1)"
if [ -z "${BRIDGE_GW}" ]; then
  BRIDGE_GW="$(ip -4 addr show docker0 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')"
fi

if [ -n "${BRIDGE_GW}" ]; then
  echo "[livekit-entrypoint] binding signaling to ${BRIDGE_GW} + 127.0.0.1 (7880 stays off the public interface)" >&2
  set -- "$@" --bind "${BRIDGE_GW}" --bind 127.0.0.1
else
  echo "[livekit-entrypoint] WARN: could not discover the docker bridge gateway — leaving the default bind. Verify 7880 is firewalled." >&2
fi

if [ -n "${NODE_IP_VAL}" ]; then
  echo "[livekit-entrypoint] advertising node-ip ${NODE_IP_VAL}" >&2
  exec /livekit-server "$@" --node-ip "${NODE_IP_VAL}"
fi

echo "[livekit-entrypoint] WARN: no TURN_EXTERNAL_IP/LIVEKIT_NODE_IP set — LiveKit will auto-detect (may advertise docker bridge IPs)." >&2
exec /livekit-server "$@"
