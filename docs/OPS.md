# Operations runbook

This document covers backups, monitoring, and incident response for a
self-hosted OneToThree deployment. The reference deployment lives at
`~/stacks/onetothree.ru/` (see [`infra/README.md`](../infra/README.md))
but the scripts work for any path — set `PROJECT_ROOT` to override.

## Backups

### What gets backed up

[`scripts/backup.ts`](../scripts/backup.ts) produces a single timestamped
archive `backups/p13-stash-<TS>.tar.gz[.enc]` containing:

* `postgres_dump.sql` — full `pg_dumpall` of the running `db` container
* `minio_data/` — full copy of the MinIO data directory (encrypted user
  blobs, avatar bucket, etc)

Encryption with AES-256-CBC is enabled when `BACKUP_PASSPHRASE` (or the
secrets file `secrets/backup_encryption_key`) is set — strongly
recommended for off-site copies.

### Wrapper for production: backup-cron.sh

[`scripts/backup-cron.sh`](../scripts/backup-cron.sh) is the shell
wrapper used by the systemd timer. On top of the raw backup it adds:

* GFS retention: keeps `RETENTION_DAILY=7`, `RETENTION_WEEKLY=4`,
  `RETENTION_MONTHLY=6` archives by default.
* Off-site sync via `rsync` when `BACKUP_REMOTE=user@host:/path` is set.
* Healthchecks.io style heartbeat to `BACKUP_HEALTHCHECK_URL`.

Configure via `~/stacks/onetothree.ru/.env.backup`:

```ini
# Required for encryption (already populated by ./startup.sh)
BACKUP_PASSPHRASE_FILE=$HOME/stacks/onetothree.ru/secrets/backup_encryption_key

# Optional — comment out if you don't want off-site copies
BACKUP_REMOTE=backup@your-storage.example:/srv/onetothree

# Optional — sign up at healthchecks.io for free
BACKUP_HEALTHCHECK_URL=https://hc-ping.com/<uuid>

# Optional retention overrides
# RETENTION_DAILY=14
# RETENTION_WEEKLY=8
# RETENTION_MONTHLY=12
```

### Install the systemd timer

```bash
bash infra/systemd/install.sh   # NO sudo — user-level units
```

Drops `onetothree-backup.{service,timer}` and
`onetothree-uptime.{service,timer}` into `~/.config/systemd/user/`,
reloads the daemon, enables both timers, and turns on linger so they
keep firing after logout. Backup runs at 03:17 UTC daily with up to
15 minutes of randomized jitter to avoid colliding with the media
retention purge that runs in the same window.

Manual ops:

```bash
# Force a backup now
systemctl --user start onetothree-backup.service
journalctl --user -u onetothree-backup.service -f

# When does the next one fire?
systemctl --user list-timers onetothree-*

# Disable temporarily
systemctl --user disable --now onetothree-backup.timer
```

### Restore drill — do this every quarter

```bash
# pick any archive from ~/stacks/onetothree.ru/backups/
RESTORE_CONFIRM=YES bash scripts/backup-restore.sh \
  ~/stacks/onetothree.ru/backups/p13-stash-2026-05-15T03-17-00.tar.gz.enc
```

The script:

1. Decrypts (if `.enc` and `BACKUP_PASSPHRASE_FILE` is readable).
2. Stops `api` and `web`. `db` and `minio` stay up so we can stream into them.
3. Pipes `postgres_dump.sql` into `psql` inside the `db` container.
4. Wipes the live MinIO `/data/` and `docker cp`s the snapshot back in.
5. Restarts `api` and `web`.

**Always rehearse this on a staging box before you need it.** A backup
you can't restore is not a backup.

## Uptime monitoring

[`scripts/uptime-check.sh`](../scripts/uptime-check.sh) hits `api/health`
and the web `/` route every minute via a separate systemd timer
(`onetothree-uptime.timer`) and pings a Healthchecks.io heartbeat URL on
success. If two consecutive runs fail the heartbeat misses its deadline
and Healthchecks emails / Telegrams / Slacks you (configure on their
side).

Configure via `~/stacks/onetothree.ru/.env.uptime`:

```ini
UPTIME_HEALTHCHECK_URL=https://hc-ping.com/<uuid>
# Optional overrides:
# UPTIME_API_URL=https://api.onetothree.ru/health
# UPTIME_WEB_URL=https://onetothree.ru/
```

Self-hosted alternatives: Uptime Kuma on a separate VPS, statping,
prometheus blackbox exporter. The script's only job is to be a thin
"alive" pulse — pick whatever notification path you prefer.

## Disk usage

The MinIO `forestmessenger_minio_data` volume grows with attachments.
Server-side retention purges encrypted blobs older than
`MEDIA_RETENTION_DAYS` (default 30); the LRU evictor cuts in at 90% of
the configured quota.

Manual size check:

```bash
docker system df -v | grep -E 'forestmessenger_minio_data|forestmessenger_pgdata'
```

If the disk is filling faster than retention can keep up, drop
`MEDIA_RETENTION_DAYS` in `.env.prod` and restart `api` to pick up the
new value.

## Incident response

| Symptom | First check | Likely fix |
|---|---|---|
| `https://onetothree.ru/` 5xx | `journalctl -u onetothree-uptime.service -n 20` | `docker compose -f docker-compose.prod.yml logs --tail=200 web` |
| `https://api.onetothree.ru/health` not 200 | `docker compose ... logs --tail=200 api` | restart api: `docker compose ... up -d --force-recreate api` |
| `api.onetothree.ru` answers **404 `{"detail":"Not Found"}`** (a different framework's body) right after the api was recreated, while `docker exec forestmessenger-api-1 …/api/version` is fine | `docker exec infra-caddy getent hosts api` — more than one address, and the api's is not first | Caddy must proxy to the **container name**: `reverse_proxy forestmessenger-api-1:8080` in `~/stacks/caddy/sites/onetothree.ru.caddy` (then `caddy validate` + `caddy reload`), never to the generic alias `api`. The shared `edge` network also carries other stacks' `api` containers (`wolf4x-cloud-api` has the alias `api` too); which address Docker's DNS lists first follows container age, so recreating the api silently moved Caddy's traffic to the wrong service |
| Caddy can't get TLS cert | `docker logs infra-caddy --tail=50` | DNS or rate-limit issue — wait, then `docker compose ... reload` |
| Disk full | `df -h /` and `docker system df` | drop old media (lower retention) or prune docker images |
| Last backup unknown | `systemctl status onetothree-backup.timer` | `systemctl start onetothree-backup.service` |

## Rolling back a bad deploy

```bash
cd ~/stacks/onetothree.ru
git log --oneline -5                    # find the last good SHA
git reset --hard <good-sha>
docker compose -f docker-compose.prod.yml up -d --build api web
```

Or use the GitHub Releases page to grab the previous tag and
`git checkout` it.

## TURN relay hardening

coturn is the one internet-facing service that sends UDP wherever a signed-in
user tells it to, so it hands out nothing a stranger can reuse and refuses the
places it could be aimed at.

### Credentials

- **Per user, time-limited** (the TURN REST API). `GET /api/ice-servers` returns
  `username = "<expiry unix>:<user id>"` and
  `credential = base64(HMAC-SHA1(secret, username))`; coturn recomputes it
  (`use-auth-secret`) and refuses it after the expiry. Lifetime:
  `TURN_CREDENTIAL_TTL_SEC`, default 7200 (2 h), range 60–86400. There is no
  shared TURN password and no `--user` account. A leftover `TURN_PASSWORD` /
  `TURN_USERNAME` in `.env.prod` is ignored (the api logs one error naming the
  variable) — delete it.
- **The secret is a file**: `secrets/turn_auth_secret`, mode 0644 inside the 0700
  `secrets/` directory like the others (the api runs as uid 1001). The api reads
  it through `TURN_AUTH_SECRET_FILE`; coturn's entrypoint copies it into a runtime
  config on a tmpfs, so it is in neither `ps` nor `docker inspect`.
- **A call longer than the lifetime.** coturn re-checks the credentials on every
  Allocate refresh, so a relay that outlives them is dropped at the next refresh.
  The web client fetches fresh credentials before an ICE restart when its own are
  within 10 minutes of expiry, so a call over ~2 h sees one short reconnect
  instead of ending.
- **Rotating the secret** (do it when it may have leaked, not on a schedule):

  ```bash
  cd ~/stacks/onetothree.ru
  openssl rand -hex 32 | tr -d '\n' > secrets/turn_auth_secret.new
  chmod 644 secrets/turn_auth_secret.new && mv secrets/turn_auth_secret.new secrets/turn_auth_secret
  docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate api coturn
  ```

  Calls in progress drop for about 10 seconds; every client gets credentials
  signed with the new secret at its next fetch. Check there is no other deploy
  running first (see `scripts/deploy-prod.sh`).

### Which peers the relay may reach

`docker/coturn/turnserver.conf` refuses private, loopback, link-local, CGNAT,
benchmarking, reserved and multicast addresses as relay peers, and
`no-tcp-relay` removes RFC 6062 TCP allocations — the way a TURN user opens TCP
connections *from* the relay. Browsers use neither.

The server's **own public address is deliberately not on that list.** The api
answers `transportPolicy: relay`, so a call is relay ↔ relay: both legs end on
this coturn, and each leg's peer *is this host's public address*. Denying it
makes every such call fail with `403 Forbidden IP` on CreatePermission —
measured on coturn 4.13.1, not assumed. So what remains reachable through the
relay is **UDP** to this host's public address, from that same address: in
practice services that are public anyway (coturn itself, LiveKit's UDP port,
HTTP/3 on :443, VPN ports). Two consequences:

- a gateway or proxy that trusts the host's own address would see that traffic as
  trusted. HTTP/3 is the only HTTP that UDP can carry, and Caddy can stop
  serving it (`servers { protocols h1 h2 }`) if the gateway makes that matter;
- the host firewall can close the gap without touching calls — UDP from a relay
  port to anything local that is not itself a relay port:

  ```bash
  # needs root; add it to the firewall's persistent configuration as well
  iptables  -I OUTPUT 1 -o lo -p udp -m owner --uid-owner 0 --sport 49160:49200 ! --dport 49160:49200 -j DROP
  ip6tables -I OUTPUT 1 -o lo -p udp -m owner --uid-owner 0 --sport 49160:49200 ! --dport 49160:49200 -j DROP
  ```

  `--uid-owner 0` is coturn (container root). Relay ↔ relay traffic has a relay
  port at both ends and is untouched; so is traffic to remote peers (it does not
  leave through `lo`). Another root process whose ephemeral source port happens to
  fall in 49160–49200 and that talks to a local UDP service would be dropped too —
  rare, and a retry picks another port. Verify with the probe below.

`TURN_DENIED_PEER_IPS` (comma separated; the entrypoint turns each entry into a
`denied-peer-ip=` line) is for addresses that must not be committed to a public
repository. This host's own **IPv6** address is safe to list (a relay ↔ relay leg
does not use it); do not list the IPv4 one unless your clients never relay
through this host.

### Verifying it — `scripts/turn-probe.mjs`

A dependency-free TURN client. Run it on the TURN host, so its delivery test can
listen on the host's own addresses:

```bash
cd ~/stacks/onetothree.ru
docker run --rm --network host \
  -v "$PWD/scripts/turn-probe.mjs:/probe.mjs:ro" \
  -v "$PWD/secrets/turn_auth_secret:/secret:ro" \
  node:22-alpine node /probe.mjs \
    --host turn.example.org --secret-file /secret \
    --own-ip <public IPv4> --own-ip <public IPv6>
```

It checks that anonymous Allocate and a wrong password are refused, valid
credentials are accepted, a TCP allocation is refused, private / loopback /
link-local / CGNAT / multicast peers are refused (for loopback it also checks that
a datagram really does not arrive), reports whether the host's own addresses are
reachable (`--own-policy blocked` makes that a failure once the firewall rule is
in), and that two allocations still reach each other (`--relay-to-relay allow`).
`--transport tcp` and `--transport tls --servername <host>` cover 3478/tcp and
5349; `--user turn --password-env OLD_PASSWORD --expect-rejected` proves a retired
password no longer works. The exit status is 1 when any check fails. Run it after
**any** recreate of coturn, over all three transports (udp, tcp, tls): the
`cap_drop: [ALL]` + `cap_add: [NET_BIND_SERVICE, DAC_READ_SEARCH]` pair in
`docker-compose.prod.yml` exists because a bare `cap_drop: [ALL]` makes this
image's `turnserver` fail to start, and because without the read-only
`DAC_READ_SEARCH` root in the container cannot read the 0640 TLS key mounted
from the host, so coturn starts *without* TURNS on :5349 and logs one warning —
both sat unnoticed until the container was next recreated, and the second one is
only visible to a probe that actually opens `--transport tls`.

## Metrics

The API exposes Prometheus metrics at `GET /metrics`, **opt-in**: with
`METRICS_TOKEN` unset the route is not registered and the path 404s, so an
instance that did not ask for metrics exposes nothing. Set a long random token
(shorter than 16 characters is treated as unset — a secret that looks like
protection and is not is worse than none):

```bash
# .env.prod
METRICS_TOKEN=$(openssl rand -hex 32)
```

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://api.example.com/metrics
```

A wrong or missing token also gets 404, not 401: the answer must not confirm
that this instance serves metrics at all.

What it exports — deliberately small, with **no per-user series** (a scrape must
not become a way to enumerate who is online) and **no I/O** (no query, no Redis
round trip: monitoring must not add load to a database precisely when it is
being asked why the database is slow):

| Metric | Meaning |
|---|---|
| `onetothree_build_info{version,commit,node}` | which build answered |
| `onetothree_process_uptime_seconds` | seconds since this API process started |
| `onetothree_process_resident_memory_bytes`, `…_heap_used_bytes` | process memory |
| `onetothree_log_lines_total{level="warn"\|"error"}` | log lines at or above warn since start |
| `onetothree_ws_connected_users`, `onetothree_ws_sockets` | live WebSockets on this instance |

`onetothree_log_lines_total` is the one to alert on first. A healthy instance
sits flat; a background job failing on a timer climbs steadily, which is exactly
the shape that once went unnoticed for five days because the only trace was a
log line nobody read. The same counter is visible in `/admin` → CONFIG.

### Wired up on the reference deployment

Prometheus, Alertmanager and Grafana already run on this host as their own stack
(`~/stacks/monitoring`, repo `therudywolf/monitoring`). OneToThree is scraped
from there — no new stack was needed:

- **Job.** `job_name: onetothree`, target `forestmessenger-api-1:8080`, over the
  shared `edge` Docker network. The api container publishes no port, so the
  bearer token never crosses the public edge; nothing about metrics is reachable
  from the internet.
- **Token.** `METRICS_TOKEN` in `.env.prod`, and the same value in
  `~/stacks/monitoring/secrets/onetothree_metrics_token`, mounted read-only into
  the Prometheus container. That file is **0644 inside a 0700 directory** on
  purpose: Prometheus runs as uid 65534 and silently fails to read a 0600 file —
  the same trap that once left LiveKit without its keys.
- **Dashboard.** `grafana/dashboards/onetothree.json`, provisioned from file, at
  `/monitoring/d/onetothree`. Scrape state, live build, uptime, sockets, memory,
  and the warn/error curve.
- **Alerts.** Group `onetothree` in `prometheus/rules/alerts.yml`:

  | Alert | Fires when | Why that threshold |
  |---|---|---|
  | `OneToThreeApiMetricsDown` | `up == 0` for 3 min | The container is running but not serving. The blackbox probe only says the public URL answers |
  | `OneToThreeErrors` | any error line in 15 min | Errors are rare here; one is worth a look |
  | `OneToThreeWarningsClimbing` | >10 warn lines in 1 h | The guest sweeper ticks every 5 min, so a job failing on a timer produces ~12/h while a healthy instance produces ~0 |
  | `OneToThreeApiRestarting` | uptime resets >2× in 1 h | A crash loop looks healthy to every individual probe |
  | `OneToThreeApiMemoryHigh` | RSS >850 MB for 15 min | The container is capped at 1 GB; the next spike is an OOM kill |

To point a different Prometheus at it, copy the job above and give it the token.
To turn the whole thing off, remove `METRICS_TOKEN` and restart the api — the
route stops existing and the target simply goes down.
