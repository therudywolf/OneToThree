#!/usr/bin/env bash
# Restore an OneToThree backup archive into the running stack.
#
# Usage:
#   ./scripts/backup-restore.sh path/to/p13-stash-2026-05-15T03-00-00.tar.gz[.enc]
#
# What it does:
#   1. Decrypts (if .enc, using BACKUP_PASSPHRASE_FILE)
#   2. Extracts to a tmp dir
#   3. Stops api/web (db/minio stay up)
#   4. psql -f postgres_dump.sql against the running db container
#   5. docker cp minio_data/ back into minio container
#   6. Restarts api/web
#
# Designed to be run during a drill or recovery — DESTRUCTIVE.
# Refuses to run unless RESTORE_CONFIRM=YES is in env.

set -euo pipefail

ROOT="${PROJECT_ROOT:-$HOME/sites/onetothree.ru}"
ARCHIVE="${1:-}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-$ROOT/secrets/backup_encryption_key}"

[[ -n "$ARCHIVE" ]] || { echo "usage: $0 <archive>" >&2; exit 2; }
[[ -f "$ARCHIVE" ]] || { echo "archive not found: $ARCHIVE" >&2; exit 2; }
[[ "${RESTORE_CONFIRM:-}" == "YES" ]] || {
  echo "DESTRUCTIVE: re-run with RESTORE_CONFIRM=YES to proceed" >&2
  exit 2
}

cd "$ROOT"
TMP="$(mktemp -d -t p13-restore-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

log() { printf '%s [restore] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# 1. Decrypt
SRC="$ARCHIVE"
if [[ "$ARCHIVE" == *.enc ]]; then
  [[ -r "$BACKUP_PASSPHRASE_FILE" ]] || { echo "passphrase file required for .enc" >&2; exit 2; }
  BACKUP_PASSPHRASE="$(cat "$BACKUP_PASSPHRASE_FILE")"
  export BACKUP_PASSPHRASE
  log "decrypting..."
  openssl enc -aes-256-cbc -pbkdf2 -d -salt \
    -in "$ARCHIVE" -out "$TMP/archive.tar.gz" -pass env:BACKUP_PASSPHRASE
  SRC="$TMP/archive.tar.gz"
fi

# 2. Extract
log "extracting to $TMP/extract..."
mkdir -p "$TMP/extract"
tar -xzf "$SRC" -C "$TMP/extract"
[[ -f "$TMP/extract/postgres_dump.sql" ]] || { echo "postgres_dump.sql missing" >&2; exit 1; }
[[ -d "$TMP/extract/minio_data" ]] || { echo "minio_data missing" >&2; exit 1; }

# 3. Stop api+web (keep db+minio running)
log "stopping api+web..."
docker compose -f docker-compose.prod.yml stop api web

# 4. Restore postgres
DB_NODE="$(docker compose -f docker-compose.prod.yml ps -q db)"
[[ -n "$DB_NODE" ]] || { echo "db container not running" >&2; exit 1; }
log "piping postgres_dump.sql into $DB_NODE..."
docker exec -i "$DB_NODE" psql -U forest -d postgres < "$TMP/extract/postgres_dump.sql"

# 5. Restore minio
MINIO_NODE="$(docker compose -f docker-compose.prod.yml ps -q minio)"
[[ -n "$MINIO_NODE" ]] || { echo "minio container not running" >&2; exit 1; }
log "wiping current minio data..."
docker exec "$MINIO_NODE" sh -c 'rm -rf /data/* /data/.* 2>/dev/null || true'
log "copying minio_data into $MINIO_NODE..."
docker cp "$TMP/extract/minio_data/." "$MINIO_NODE:/data"
docker exec "$MINIO_NODE" sh -c 'chown -R 1000:1000 /data' || true

# 6. Restart api+web
log "restarting api+web..."
docker compose -f docker-compose.prod.yml start api web

log "restore complete; verify via curl https://api.onetothree.ru/health"
