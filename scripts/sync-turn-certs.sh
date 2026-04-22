#!/usr/bin/env bash
# sync-turn-certs.sh — copy the Let's Encrypt cert Caddy manages into the
# location coturn reads on container startup.
#
# Run once after the first successful ACME issuance, and then from cron
# (`0 4 * * * /opt/forest/scripts/sync-turn-certs.sh --quiet`).
#
# Exit 0 on success, non-zero otherwise.
set -euo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
TURN_HOST="${TURN_HOST:-turn.onetothree.ru}"
TLS_OUT="$REPO_DIR/docker/coturn/tls"

QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then QUIET=1; fi

log() {
  if [[ $QUIET -eq 0 ]]; then
    echo "[sync-turn-certs] $*"
  fi
}

err() {
  echo "[sync-turn-certs][ERR] $*" >&2
}

# Locate the Caddy data volume (named `forestmessenger_caddy_data`).
CADDY_VOL="$(docker volume inspect forestmessenger_caddy_data --format '{{ .Mountpoint }}' 2>/dev/null || true)"
if [[ -z "$CADDY_VOL" ]]; then
  err "Caddy data volume not found. Is docker-compose.prod up?"
  exit 2
fi

SRC="$CADDY_VOL/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$TURN_HOST"
if [[ ! -d "$SRC" ]]; then
  err "Certificate directory missing: $SRC"
  err "Make sure Caddy has a site block for $TURN_HOST that forces TLS provisioning"
  err "(add 'tls { on_demand }' or a dummy reverse_proxy site)."
  exit 3
fi

mkdir -p "$TLS_OUT"
cp -f "$SRC/$TURN_HOST.crt" "$TLS_OUT/fullchain.pem"
cp -f "$SRC/$TURN_HOST.key" "$TLS_OUT/privkey.pem"
chmod 0640 "$TLS_OUT/fullchain.pem" "$TLS_OUT/privkey.pem"
log "Copied $TURN_HOST TLS material into $TLS_OUT"

# Restart coturn so it reloads the new key material.
if docker compose -f "$REPO_DIR/docker-compose.prod.yml" ps coturn >/dev/null 2>&1; then
  docker compose -f "$REPO_DIR/docker-compose.prod.yml" restart coturn >/dev/null
  log "coturn restarted"
fi

exit 0
