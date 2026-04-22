# coturn TLS certificates

This directory holds the TLS certificate and private key used by coturn
for `turns:` (TURN-over-TLS on port 5349).

At container start coturn expects:

* `docker/coturn/tls/fullchain.pem`
* `docker/coturn/tls/privkey.pem`

## Recommended workflow (production)

1. Let Caddy acquire and maintain a certificate for `turn.onetothree.ru`.
   Caddy persists the cert bundle inside the `caddy_data` Docker volume at
   `/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.onetothree.ru/`.
2. Run `scripts/sync-turn-certs.sh` (operator script) on the host — it
   copies `fullchain.pem` / `privkey.pem` from the Caddy volume into
   `docker/coturn/tls/` and `docker compose restart coturn`.
3. Schedule the sync script via cron (daily) so coturn picks up renewed
   certificates transparently.

Never commit real certificate material to the repository.
