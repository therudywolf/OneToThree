#!/usr/bin/env sh
# coturn conditional-TLS entrypoint.
#
# Passes all arguments to turnserver unchanged.
# Adds --no-tls when TLS certificates are not yet provisioned so coturn
# starts successfully even before `scripts/sync-turn-certs.sh` has run.
# Once certs are copied and the container restarted, TLS activates automatically.
#
# Expected cert paths (mounted from ./docker/coturn/tls):
#   /etc/coturn/tls/fullchain.pem
#   /etc/coturn/tls/privkey.pem

CERT="/etc/coturn/tls/fullchain.pem"
KEY="/etc/coturn/tls/privkey.pem"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "[coturn-entrypoint] TLS certs found — starting with TURNS on port 5349"
  exec turnserver "$@"
else
  echo "[coturn-entrypoint] No TLS certs — starting plain TURN only (run scripts/sync-turn-certs.sh to enable TURNS)"
  exec turnserver --no-tls "$@"
fi
