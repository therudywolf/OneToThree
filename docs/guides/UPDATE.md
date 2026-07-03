# Update Guide

How to safely update OneToThree to the latest version without losing data.

**[Русская версия → UPDATE.ru.md](./UPDATE.ru.md)**

---

## Table of Contents

- [When to Update](#when-to-update)
- [Pre-Update: Create a Backup](#pre-update-create-a-backup)
- [Update Command](#update-command)
- [What Happens Internally](#what-happens-internally)
- [Verify the Update](#verify-the-update)
- [Rollback if Something Breaks](#rollback-if-something-breaks)
- [Why Your Data Is Safe](#why-your-data-is-safe)

---

## When to Update

Check for new releases and changes:

- **GitHub releases:** https://github.com/therudywolf/OneToThree/releases
- **Commit history:** `git log --oneline origin/main..HEAD` (shows what's new upstream)

Update whenever there are security patches, bug fixes, or new features you want.

---

## Pre-Update: Create a Backup

Always create a backup before updating:

```bash
./startup.sh backup
```

This creates a compressed database dump at `backups/db_YYYYMMDD_HHMMSS.sql.gz`.

For a full backup including media files:

```bash
# Database
./startup.sh backup

# Media (MinIO volume)
docker run --rm -v forestmessenger_minio_data:/data -v $(pwd)/backups:/backup \
  alpine tar czf /backup/minio_$(date +%Y%m%d_%H%M%S).tar.gz -C /data .
```

---

## Update Command

```bash
./startup.sh update
```

That's it. One command.

---

## What Happens Internally

The `./startup.sh update` command runs the following steps:

1. **`doctor` preflight** — checks git, Docker, `.env`, compose config, and disk space
2. **`git fetch --all --prune`** + a **fast-forward-only** pull of the current branch
3. **Re-syncs `DOMAIN`** and all derived vars in `.env.prod`
4. **Builds and runs `db-migrate`** idempotently (applies any new Drizzle migrations)
5. **Rebuilds/restarts only the affected services** — or all core services with `--full`
6. **Health checks** — service health, API `/health`, CSP, and optional TURN TLS

Useful modes: `--full`, `--no-pull`, `--no-cache`, `--skip-smoke`. The whole process
typically takes 3–5 minutes, depending on how much changed and your build speed.

---

## Verify the Update

After the update completes:

```bash
# Check all containers are healthy
./startup.sh status

# Check logs for errors
./startup.sh logs

# Verify the site loads
curl -sI https://your-domain.com | head -5
```

If `db-migrate` shows errors, check its logs specifically:

```bash
docker compose -f docker-compose.prod.yml logs db-migrate
```

---

## Rollback if Something Breaks

If the update causes problems, you can roll back to the previous version:

### 1. Find the previous commit

```bash
git log --oneline -10
```

### 2. Check out the previous commit

```bash
git checkout PREVIOUS_COMMIT_HASH
```

### 3. Rebuild and restart

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build --remove-orphans
```

### 4. Restore the database (if needed)

If a migration made destructive changes and you need to restore data:

```bash
gunzip -c backups/db_YYYYMMDD_HHMMSS.sql.gz | \
  docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T db psql -U forest -d forest
```

### 5. Return to tracking main

Once the issue is resolved upstream:

```bash
git checkout main
git pull origin main
./startup.sh update
```

---

## Why Your Data Is Safe

All persistent data lives in Docker named volumes:

| Volume | Contents |
|--------|----------|
| `forestmessenger_pgdata` | PostgreSQL database (users, messages, chat metadata) |
| `forestmessenger_minio_data` | Encrypted media files |

> TLS certificates are managed by the separate edge Caddy stack (outside this
> compose project), not by a volume here.

These volumes are **never touched** by `docker compose up --build`. Image rebuilds only replace the container code, not the volumes.

> **Warning:** The only command that deletes volumes is `docker compose down -v`. Never use the `-v` flag unless you intentionally want to erase all data.

### What is NOT stored in volumes

- Application code (rebuilt from source on each update)
- Node modules (rebuilt inside containers)
- Temporary files (cleared on container restart)

These are all regenerated automatically during the build process.
