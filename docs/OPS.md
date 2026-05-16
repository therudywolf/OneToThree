# Operations runbook

This document covers backups, monitoring, and incident response for a
self-hosted OneToThree deployment. The reference deployment lives at
`~/sites/onetothree.ru/` (see [`infra/README.md`](../infra/README.md))
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

Configure via `~/sites/onetothree.ru/.env.backup`:

```ini
# Required for encryption (already populated by ./startup.sh)
BACKUP_PASSPHRASE_FILE=/home/rudywolf/sites/onetothree.ru/secrets/backup_encryption_key

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
sudo bash infra/systemd/install.sh
```

Drops `onetothree-backup.{service,timer}` and
`onetothree-uptime.{service,timer}` into `/etc/systemd/system`, reloads
the daemon, enables both timers. Backup runs at 03:17 UTC daily with up
to 15 minutes of randomized jitter to avoid colliding with the media
retention purge that runs in the same window.

Manual ops:

```bash
# Force a backup now
sudo systemctl start onetothree-backup.service
journalctl -u onetothree-backup.service -f

# When does the next one fire?
systemctl list-timers onetothree-*

# Disable temporarily
sudo systemctl disable --now onetothree-backup.timer
```

### Restore drill — do this every quarter

```bash
# pick any archive from ~/sites/onetothree.ru/backups/
RESTORE_CONFIRM=YES bash scripts/backup-restore.sh \
  ~/sites/onetothree.ru/backups/p13-stash-2026-05-15T03-17-00.tar.gz.enc
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

Configure via `~/sites/onetothree.ru/.env.uptime`:

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
| Caddy can't get TLS cert | `docker logs infra-caddy --tail=50` | DNS or rate-limit issue — wait, then `docker compose ... reload` |
| Disk full | `df -h /` and `docker system df` | drop old media (lower retention) or prune docker images |
| Last backup unknown | `systemctl status onetothree-backup.timer` | `systemctl start onetothree-backup.service` |

## Rolling back a bad deploy

```bash
cd ~/sites/onetothree.ru
git log --oneline -5                    # find the last good SHA
git reset --hard <good-sha>
docker compose -f docker-compose.prod.yml up -d --build api web
```

Or use the GitHub Releases page to grab the previous tag and
`git checkout` it.

## Adding metrics / Grafana

Out of scope for v0.5; the planned path is:

1. Stand up `prometheus` + `grafana` on the same VPS as a separate
   docker-compose stack under `~/sites/grafana.onetothree.ru/`.
2. Wire the `infra/caddy/sites/grafana.onetothree.ru.caddy` proxy via
   `infra/add-site.sh`.
3. Add a `/metrics` endpoint to the Fastify api (already importable as
   `fastify-metrics`).
4. Scrape from prometheus, dashboard in Grafana.

File an issue when you're ready.
