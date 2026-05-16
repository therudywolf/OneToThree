#!/usr/bin/env bash
# OneToThree daily backup wrapper.
#
# Wraps `npm run backup` (scripts/backup.ts) with:
#   - retention (daily 7 / weekly 4 / monthly 6, GFS rotation)
#   - optional off-site rsync (BACKUP_REMOTE=user@host:/path)
#   - optional Healthchecks.io heartbeat (BACKUP_HEALTHCHECK_URL)
#   - structured stderr logging
#
# Designed to be invoked from a systemd timer (see infra/systemd/).
# Exit codes: 0 ok, 1 backup failed, 2 retention failed, 3 rsync failed.

set -euo pipefail

ROOT="${PROJECT_ROOT:-/home/rudywolf/sites/onetothree.ru}"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-$ROOT/secrets/backup_encryption_key}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
BACKUP_HEALTHCHECK_URL="${BACKUP_HEALTHCHECK_URL:-}"

# Retention policy (override via env). The script keeps:
#   - $RETENTION_DAILY most recent dailies (default 7)
#   - $RETENTION_WEEKLY most recent weeklies (one per ISO week, default 4)
#   - $RETENTION_MONTHLY most recent monthlies (one per calendar month, default 6)
RETENTION_DAILY="${RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${RETENTION_WEEKLY:-4}"
RETENTION_MONTHLY="${RETENTION_MONTHLY:-6}"

log() { printf '%s [backup] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

ping_health() {
  local suffix="${1:-}"  # empty | /start | /fail
  [[ -n "$BACKUP_HEALTHCHECK_URL" ]] || return 0
  curl -fsS --retry 3 -m 10 -o /dev/null "${BACKUP_HEALTHCHECK_URL}${suffix}" \
    || log "healthcheck ping failed (non-fatal)"
}

ping_health /start

# 1. Encryption passphrase from secrets file
if [[ -r "$BACKUP_PASSPHRASE_FILE" ]]; then
  BACKUP_PASSPHRASE="$(cat "$BACKUP_PASSPHRASE_FILE")"
  export BACKUP_PASSPHRASE
  log "encryption: AES-256-CBC (passphrase from $BACKUP_PASSPHRASE_FILE)"
else
  log "encryption: DISABLED — $BACKUP_PASSPHRASE_FILE missing"
fi

# 2. Run backup
log "running npm run backup..."
mkdir -p "$BACKUP_DIR"
if ! npm run backup --silent 2>&1 | sed 's/^/[backup] /' >&2; then
  log "BACKUP FAILED"
  ping_health /fail
  exit 1
fi

# 3. Locate the just-produced archive
LATEST="$(ls -1t "$BACKUP_DIR"/p13-stash-*.tar.gz* 2>/dev/null | head -1 || true)"
if [[ -z "$LATEST" ]]; then
  log "backup completed but no archive found in $BACKUP_DIR"
  ping_health /fail
  exit 1
fi
SIZE_MB="$(du -m "$LATEST" | cut -f1)"
log "produced: $LATEST (${SIZE_MB} MB)"

# 4. Retention — GFS rotation
apply_retention() {
  local kept_daily=0 kept_weekly=0 kept_monthly=0
  local last_week="" last_month=""
  # iterate newest -> oldest; tag each as daily/weekly/monthly until limits hit
  mapfile -t archives < <(ls -1t "$BACKUP_DIR"/p13-stash-*.tar.gz* 2>/dev/null || true)
  for f in "${archives[@]}"; do
    local stamp basename
    basename="$(basename "$f")"
    stamp="$(printf '%s' "$basename" | sed -E 's/^p13-stash-([0-9-]+T[0-9-]+).*$/\1/' | tr T ' ' | sed 's/-/:/3g; s/-/:/3g; s/T/ /')"
    # Fall back to file mtime when filename parse fails (legacy archives)
    local epoch
    if epoch="$(date -d "$stamp" +%s 2>/dev/null)" && [[ -n "$epoch" ]]; then :; else
      epoch="$(stat -c %Y "$f")"
    fi
    local week month
    week="$(date -d "@$epoch" -u +%G-%V)"
    month="$(date -d "@$epoch" -u +%Y-%m)"

    local keep=0
    if (( kept_daily < RETENTION_DAILY )); then
      keep=1; kept_daily=$((kept_daily + 1))
    fi
    if (( kept_weekly < RETENTION_WEEKLY )) && [[ "$week" != "$last_week" ]]; then
      keep=1; kept_weekly=$((kept_weekly + 1)); last_week="$week"
    fi
    if (( kept_monthly < RETENTION_MONTHLY )) && [[ "$month" != "$last_month" ]]; then
      keep=1; kept_monthly=$((kept_monthly + 1)); last_month="$month"
    fi

    if (( keep == 0 )); then
      log "pruning $basename"
      rm -f "$f"
    fi
  done
}
if ! apply_retention; then
  log "retention pass failed (non-fatal)"
fi

# 5. Off-site rsync (optional)
if [[ -n "$BACKUP_REMOTE" ]]; then
  log "syncing to $BACKUP_REMOTE..."
  if ! rsync -az --delete --partial --inplace \
      -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
      "$BACKUP_DIR/" "$BACKUP_REMOTE/"; then
    log "off-site rsync FAILED"
    ping_health /fail
    exit 3
  fi
  log "off-site rsync ok"
fi

ping_health
log "backup complete"
