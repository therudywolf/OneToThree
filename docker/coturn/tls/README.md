# coturn TLS certificates

This directory holds the TLS certificate and private key used by coturn
for `turns:` (TURN-over-TLS on port 5349).

At container start coturn expects:

* `docker/coturn/tls/fullchain.pem`
* `docker/coturn/tls/privkey.pem`

## Recommended workflow (production)

1. Let Caddy acquire and maintain a certificate for `turn.<DOMAIN>`.
   Caddy persists the cert bundle inside the `caddy_data` Docker volume at
   `/data/caddy/certificates/<issuer>/turn.<DOMAIN>/`.
2. Run `./startup.sh turn-sync` or `scripts/sync-turn-certs.sh` on the host.
   The script resolves the TURN hostname from `.env.prod`, copies
   `fullchain.pem` / `privkey.pem` from the Caddy volume into
   `docker/coturn/tls/`, and restarts coturn only when material changed.
3. `./startup.sh update` also retries this sync after Caddy starts. Keep a daily
   cron for renewals, for example:

   `0 4 * * * cd ~/stacks/onetothree.ru && ./startup.sh turn-sync >/dev/null 2>&1`

Never commit real certificate material to the repository.
