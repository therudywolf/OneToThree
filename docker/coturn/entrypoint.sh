#!/usr/bin/env sh
# coturn entrypoint: builds the runtime config, then execs turnserver.
#
# 1. TURN REST API secret. docker/coturn/turnserver.conf is committed, so the
#    secret cannot live in it. It is read from the Docker secret
#    `turn_auth_secret` (the same file the api reads) and appended as
#    `static-auth-secret=…` to a RUNTIME copy of the config that is written to a
#    tmpfs and handed to turnserver with -c. That keeps it out of argv, so it is
#    not in `ps`, `/proc/<pid>/cmdline` or `docker inspect` — the places the old
#    `--user=turn:<password>` argument put a long-lived shared password.
#    A missing, empty, short or oddly-shaped secret is FATAL: starting anyway
#    would mean a TURN server nobody can authenticate to, or worse, a config line
#    smuggled in through the secret.
#
# 2. TURN_DENIED_PEER_IPS (optional): comma/space separated IPs or IP-IP ranges
#    that are added as `denied-peer-ip=` lines. This is how an operator lists
#    addresses that must not be committed to a public repository. Read the
#    warning in turnserver.conf before listing this host's own IPv4 address: a
#    relay-only call is relay <-> relay and its peer IS that address.
#
# 3. TLS. Adds --no-tls when certificates are not yet provisioned so coturn
#    starts before `scripts/sync-turn-certs.sh` has run. Once certs are copied
#    and the container restarted, TLS activates automatically.
#
# Everything else on the command line (--realm, --external-ip, …) is passed to
# turnserver unchanged.
#
# Paths are overridable only so the contract test can run this script without a
# container; compose never sets them.

set -eu

CONF_SOURCE="${TURN_CONF_SOURCE:-/etc/coturn/turnserver.conf}"
SECRET_FILE="${TURN_AUTH_SECRET_FILE:-/run/secrets/turn_auth_secret}"
RUNTIME_DIR="${TURN_RUNTIME_DIR:-/run/coturn}"
CERT="${TURN_TLS_DIR:-/etc/coturn/tls}/fullchain.pem"
KEY="${TURN_TLS_DIR:-/etc/coturn/tls}/privkey.pem"

fatal() {
  echo "[coturn-entrypoint] FATAL: $*" >&2
  exit 1
}

[ -r "$CONF_SOURCE" ] || fatal "cannot read the config template $CONF_SOURCE"
[ -r "$SECRET_FILE" ] || fatal "cannot read $SECRET_FILE — mount the turn_auth_secret Docker secret (scripts/generate-secrets.sh creates it)"

# A trailing newline (or CRLF) is normal in a secret file; a newline anywhere
# else means two lines were pasted, and silently gluing them together would
# start coturn with a secret the api does not hold.
secret="$(cat "$SECRET_FILE")" # command substitution drops the trailing newline(s)
cr="$(printf '\r')"
secret="${secret%"$cr"}"
[ -n "$secret" ] || fatal "$SECRET_FILE is empty"
[ "${#secret}" -ge 32 ] || fatal "$SECRET_FILE holds fewer than 32 characters — generate one with: openssl rand -hex 32"
case "$secret" in
  *[!A-Za-z0-9+/=_.~-]*) fatal "$SECRET_FILE contains characters outside A-Z a-z 0-9 + / = _ . ~ - (use: openssl rand -hex 32)" ;;
esac

umask 077
mkdir -p "$RUNTIME_DIR"
RUNTIME_CONF="$RUNTIME_DIR/turnserver.conf"

{
  cat "$CONF_SOURCE"
  printf '\n# --- appended by entrypoint.sh at start-up (never committed) ---\n'
  printf 'use-auth-secret\n'
  printf 'static-auth-secret=%s\n' "$secret"
  denied="$(printf '%s' "${TURN_DENIED_PEER_IPS:-}" | tr ',' ' ')"
  if [ -n "$denied" ]; then
    set -f # an entry like "*" must not be expanded against the file system
    for ip in $denied; do
      case "$ip" in
        *[!0-9A-Fa-f:.-]*) fatal "TURN_DENIED_PEER_IPS entry '$ip' is not an IP address or IP-IP range" ;;
      esac
      printf 'denied-peer-ip=%s\n' "$ip"
    done
    set +f
  fi
} > "$RUNTIME_CONF"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "[coturn-entrypoint] TLS certs found — starting with TURNS on port 5349"
else
  echo "[coturn-entrypoint] No TLS certs — starting plain TURN only (run scripts/sync-turn-certs.sh to enable TURNS)"
  set -- --no-tls "$@"
fi

exec turnserver -c "$RUNTIME_CONF" "$@"
