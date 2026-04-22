# Update Guide

How to safely update Forest Messenger to the latest version without losing data.

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
- **Commit history:** `git log --oneline origin/master..HEAD` (shows what's new upstream)

Update whenever there are security patches, bug fixes, or new features you want.

---

## Pre-Update: Create a Backup

Always create a backup before updating:

```bash
./start.sh backup
```

This creates a compressed database dump at `backups/db_YYYYMMDD_HHMMSS.sql.gz`.

For a full backup including media files:

```bash
# Database
./start.sh backup

# Media (MinIO volume)
docker run --rm -v forestmessenger_minio_data:/data -v $(pwd)/backups:/backup \
  alpine tar czf /backup/minio_$(date +%Y%m%d_%H%M%S).tar.gz -C /data .
```

---

## Update Command

```bash
./start.sh update
```

That's it. One command.

---

## What Happens Internally

The `./start.sh update` command runs the following steps:

1. **`git pull origin master`** — downloads the latest source code
2. **`docker compose up -d --build --remove-orphans`** — rebuilds Docker images from the updated code and restarts containers; removes any orphaned containers from removed services
3. **Database migrations** — the `db-migrate` container runs automatically on every startup, applying any new Drizzle ORM migrations to the database schema

The entire process typically takes 3–5 minutes, depending on how much has changed and your server's build speed.

---

## Verify the Update

After the update completes:

```bash
# Check all containers are healthy
./start.sh status

# Check logs for errors
./start.sh logs

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

### 5. Return to tracking master

Once the issue is resolved upstream:

```bash
git checkout master
git pull origin master
./start.sh update
```

---

## Why Your Data Is Safe

All persistent data lives in Docker named volumes:

| Volume | Contents |
|--------|----------|
| `forestmessenger_pgdata` | PostgreSQL database (users, messages, chat metadata) |
| `forestmessenger_minio_data` | Encrypted media files |
| `forestmessenger_caddy_data` | TLS certificates (Let's Encrypt) |
| `forestmessenger_caddy_config` | Caddy configuration state |

These volumes are **never touched** by `docker compose up --build`. Image rebuilds only replace the container code, not the volumes.

> **Warning:** The only command that deletes volumes is `docker compose down -v`. Never use the `-v` flag unless you intentionally want to erase all data.

### What is NOT stored in volumes

- Application code (rebuilt from source on each update)
- Node modules (rebuilt inside containers)
- Temporary files (cleared on container restart)

These are all regenerated automatically during the build process.
