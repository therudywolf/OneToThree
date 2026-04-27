#!/usr/bin/env bash
# =============================================================================
# OneToThree (Forest Messenger) — Production Launcher
# =============================================================================
# Первый запуск:
#   ./start.sh install  — генерирует секреты (покажет пароли один раз), запускает стек
#   ./start.sh          — то же самое, короткий путь
#
# Сброс и чистый старт:
#   ./start.sh clean    — удаляет volumes и секреты, готов к свежему деплою
#
# Управление:
#   ./start.sh stop     — остановить
#   ./start.sh restart  — перезапустить без пересборки
#   ./start.sh logs     — хвост логов всех сервисов
#   ./start.sh status   — состояние контейнеров
#   ./start.sh update   — git pull + пересборка + перезапуск
#   ./start.sh backup   — резервная копия БД
#
# Compose подставляет ${TURN_PASSWORD} и др. в docker-compose.prod.yml из файла
# `.env` в корне репозитория. Скрипт зеркалит .env.prod → .env и подтягивает TURN_*
# из ./secrets/, чтобы даже «голый» docker compose -f docker-compose.prod.yml ps
# не падал на интерполяции coturn.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# --- Цвета -------------------------------------------------------------------
RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
CYN='\033[0;36m'
DIM='\033[0;90m'
BLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYN}  ▸${NC} $*"; }
ok()   { echo -e "${GRN}  ✓${NC} $*"; }
warn() { echo -e "${YEL}  ⚠${NC} $*"; }
err()  { echo -e "${RED}  ✗${NC} $*" >&2; }
die()  { err "$*"; exit 1; }
sep()  { echo -e "${DIM}  ────────────────────────────────────────────${NC}"; }

ENV_FILE="${ENV_FILE:-.env.prod}"
COMPOSE_FILE="docker-compose.prod.yml"
MESH_ENV_FILE="${MESH_ENV_FILE:-.env.mesh}"
MESH_COMPOSE_FILE="docker-compose.mesh.yml"
SECRETS_DIR="${ROOT}/secrets"
SECRETS_DONE="${SECRETS_DIR}/.initialized"
SECRETS_BACKUP_DIR="${ROOT}/secrets-backups"

# =============================================================================
# УТИЛИТЫ ЧТЕНИЯ/ЗАПИСИ ENV
# =============================================================================

val_for_key() {
  local key="$1"
  local line val
  line=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  [[ -z "$line" ]] && { echo ""; return; }
  val="${line#*=}"
  val="${val//$'\r'/}"
  val="${val#\"}" val="${val%\"}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  val="${val%%#*}"
  val="${val%"${val##*[![:space:]]}"}"
  echo "$val"
}

update_key() {
  local key="$1" val="$2"
  local tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" >"$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" "$ENV_FILE"
}

is_placeholder() {
  local v="$1"
  [[ -z "$v" ]] && return 0
  case "$v" in
    change-me*|CHANGE_ME*|your_*|YOUR_*|"<"*">") return 0 ;;
  esac
  return 1
}

trim_value() {
  local val="$1"
  val="${val//$'\r'/}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  echo "$val"
}

sync_telegram_secret_file() {
  local token="$1"
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
  echo -n "$token" > "$SECRETS_DIR/telegram_bot_token"
  chmod 600 "$SECRETS_DIR/telegram_bot_token"
}

prompt_and_save_telegram_token() {
  local allow_skip="${1:-1}"
  local current token_input
  current="$(trim_value "$(val_for_key TELEGRAM_BOT_TOKEN)")"

  if [[ -n "$current" ]] && ! is_placeholder "$current"; then
    sync_telegram_secret_file "$current"
    ok "TELEGRAM_BOT_TOKEN уже задан."
    return 0
  fi

  echo ""
  warn "Для импорта Telegram стикерпаков нужен TELEGRAM_BOT_TOKEN."
  if [[ "$allow_skip" == "1" ]]; then
    read -r -p "  Введите TELEGRAM_BOT_TOKEN (Enter чтобы пропустить): " token_input
  else
    read -r -p "  Введите TELEGRAM_BOT_TOKEN: " token_input
  fi
  token_input="$(trim_value "$token_input")"

  if [[ -z "$token_input" ]]; then
    if [[ "$allow_skip" == "1" ]]; then
      warn "TELEGRAM_BOT_TOKEN пропущен — импорт Telegram sticker pack будет недоступен."
      return 1
    fi
    die "TELEGRAM_BOT_TOKEN обязателен для этой команды."
  fi

  update_key TELEGRAM_BOT_TOKEN "$token_input"
  sync_telegram_secret_file "$token_input"
  ok "TELEGRAM_BOT_TOKEN сохранён в ${ENV_FILE} и ./secrets/telegram_bot_token."
  return 0
}

build_turn_urls() {
  local host="$1"
  echo "turn:${host}:3478,turn:${host}:3478?transport=tcp,turns:${host}:443?transport=tcp,turns:${host}:5349?transport=tcp"
}

looks_like_ip() {
  local value="$1"
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$value" == *:* ]]
}

detect_public_ip() {
  local candidate
  local endpoints=(
    "https://ifconfig.me/ip"
    "https://api.ipify.org"
    "https://ipv4.icanhazip.com"
  )

  for endpoint in "${endpoints[@]}"; do
    candidate="$(curl -fsS --max-time 5 "$endpoint" 2>/dev/null | tr -d '\r' | head -n1 | tr -d '[:space:]' || true)"
    if looks_like_ip "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

# Compose substitutes ${VAR:?…} in docker-compose.prod.yml from the shell environment
# and from a file named `.env` in the project root. Service-level `env_file:` does not
# supply those values for YAML interpolation; only `--env-file`, exported vars, or `.env` do.
# Mirror ${ENV_FILE} → `.env` and refresh TURN_* from ./secrets so
# `docker compose -f docker-compose.prod.yml ps` works without extra flags.
prime_compose_interpolation_env() {
  [[ -f "$ENV_FILE" ]] || return 0

  if [[ -f "$SECRETS_DONE" ]]; then
    if [[ -f "$SECRETS_DIR/turn_password" ]] && [[ -s "$SECRETS_DIR/turn_password" ]]; then
      local tp cur
      tp="$(tr -d '\r\n' < "$SECRETS_DIR/turn_password")"
      cur="$(val_for_key TURN_PASSWORD)"
      if [[ -z "$cur" ]] || is_placeholder "$cur" || [[ "$cur" != "$tp" ]]; then
        update_key TURN_PASSWORD "$tp"
      fi
    fi
    if [[ -f "$SECRETS_DIR/turn_external_ip" ]] && [[ -s "$SECRETS_DIR/turn_external_ip" ]]; then
      local te cur_ip
      te="$(tr -d '\r\n' < "$SECRETS_DIR/turn_external_ip")"
      cur_ip="$(val_for_key TURN_EXTERNAL_IP)"
      if [[ -z "$cur_ip" ]] || is_placeholder "$cur_ip"; then
        update_key TURN_EXTERNAL_IP "$te"
      fi
    fi
  fi

  cp -f "$ENV_FILE" "${ROOT}/.env"
}

append_service_once() {
  local service="$1"
  local existing
  for existing in "${UPDATE_SERVICES[@]:-}"; do
    [[ "$existing" == "$service" ]] && return 0
  done
  UPDATE_SERVICES+=("$service")
}

detect_update_services() {
  local diff_range="$1"
  local changed_file
  UPDATE_SERVICES=()
  UPDATE_HINTS=()

  # Special case: HEAD did not move (operator pre-pulled manually, or we are
  # re-running update after a failed build).  In that case we cannot trust
  # `git diff` to describe what the deployment needs — it will be empty.
  # Fall back to a FULL safe rebuild including db-migrate (migrations are
  # idempotent via drizzle's hash tracking, so re-running them is a no-op
  # when the schema is already at HEAD).
  local prev_head="${diff_range%%..*}"
  local curr_head="${diff_range##*..}"
  if [[ -n "$prev_head" && "$prev_head" == "$curr_head" ]]; then
    UPDATE_SERVICES=(api web caddy coturn livekit db-migrate)
    UPDATE_HINTS+=("git HEAD не изменился — запускаю полный rebuild (включая db-migrate, миграции идемпотентны).")
    return
  fi

  while IFS= read -r changed_file; do
    [[ -z "$changed_file" ]] && continue
    case "$changed_file" in
      client/*)
        append_service_once web
        ;;
      server/drizzle/*|docker/db-migrate/*|drizzle.config.ts)
        append_service_once api
        append_service_once db-migrate
        ;;
      server/*)
        append_service_once api
        ;;
      Caddyfile|deploy/*)
        append_service_once caddy
        ;;
      docker/coturn/tls/*|scripts/sync-turn-certs.sh)
        UPDATE_HINTS+=("TURN TLS-материалы изменились — выполните ./scripts/sync-turn-certs.sh и перезапустите coturn.")
        append_service_once coturn
        ;;
      docker/coturn/*)
        append_service_once coturn
        ;;
      docker/livekit/*)
        append_service_once livekit
        ;;
      package.json|package-lock.json)
        append_service_once api
        append_service_once web
        append_service_once db-migrate
        ;;
      docker-compose.prod.yml)
        append_service_once api
        append_service_once web
        append_service_once coturn
        append_service_once caddy
        append_service_once livekit
        append_service_once db-migrate
        ;;
    esac
  done < <(git diff --name-only "$diff_range" || true)

  if [[ ${#UPDATE_SERVICES[@]} -eq 0 ]]; then
    # No recognized files touched.  Default to a safe full rebuild including
    # db-migrate so an operator re-running `update` after partial failures
    # always ends up in a consistent state.
    UPDATE_SERVICES=(api web caddy coturn livekit db-migrate)
  fi
}

# Ensure docker-compose secret files exist for features that may not be
# configured yet (LiveKit, Cloudflare Calls TURN).  Empty stubs are fine — the
# server's readSecret() treats empty-file-contents as "not set" and falls back
# gracefully (CF TURN → coturn → STUN-only; LiveKit → no SFU).  This has to
# run BEFORE any `docker compose up` so the bind-mounts into the api/web
# containers succeed, hence it lives ahead of the command dispatcher rather
# than in the later setup section (which `update` never reaches because of
# its early `exit 0`).
ensure_secret_stub() {
  local name="$1"
  local path="$SECRETS_DIR/$name"
  if [[ ! -d "$SECRETS_DIR" ]]; then
    mkdir -p "$SECRETS_DIR"
    chmod 700 "$SECRETS_DIR"
  fi
  if [[ ! -f "$path" ]]; then
    : > "$path"
    chmod 600 "$path"
    warn "Создан пустой secret stub: $path (заполните позже при необходимости)"
  fi
}
ensure_secret_stub "livekit_api_key"
ensure_secret_stub "livekit_api_secret"
ensure_secret_stub "cloudflare_turn_key_id"
ensure_secret_stub "cloudflare_turn_api_token"
# totp_wrap_key is mandatory — auto-generate if missing so api container
# can mount /run/secrets/totp_wrap_key and encrypt TOTP secrets at rest.
# (Runs for every command, including `update`, which exits before the later
# «АВТОГЕНЕРАЦИЯ СЕКРЕТОВ» block — so this must stay self-contained.)
if [[ -d "$SECRETS_DIR" ]]; then
  if [[ ! -s "$SECRETS_DIR/totp_wrap_key" ]]; then
    printf '%s' "$(openssl rand -hex 32)" > "$SECRETS_DIR/totp_wrap_key"
    chmod 600 "$SECRETS_DIR/totp_wrap_key"
    warn "Сгенерирован TOTP_WRAP_KEY (AES-256-GCM ключ шифрования TOTP секретов в БД)."
  else
    tw="$(tr -d '\r\n\t ' < "$SECRETS_DIR/totp_wrap_key" || true)"
    if [[ ${#tw} -ne 64 ]] || ! [[ "$tw" =~ ^[0-9a-fA-F]{64}$ ]]; then
      die "Неверный формат secrets/totp_wrap_key: нужны ровно 64 hex-символа (openssl rand -hex 32). Без этого API в production не стартует. Если файл испорчен, а 2FA уже использовалась, восстановите прежний ключ из backup — иначе зашифрованные TOTP в БД не расшифровать."
    fi
  fi
fi

# =============================================================================
# ЗАВИСИМОСТИ (до диспетчера: stop/status/update выходят раньше блока «up» ниже)
# =============================================================================
for cmd in docker openssl curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "Не найдена команда: $cmd. Установите и повторите."
done

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  die "Docker Compose не найден. Установите Docker Desktop или плагин compose."
fi

docker info >/dev/null 2>&1 || die "Docker демон не запущен. Запустите Docker и повторите."

# =============================================================================
# КОМАНДЫ
# =============================================================================
CMD="${1:-up}"

case "$CMD" in
  install)
    CMD="up"
    ;;
  uninstall)
    CMD="clean"
    ;;
  quick)
    CMD="up"
    ;;
esac

prime_compose_interpolation_env

case "$CMD" in
  stop)
    log "Останавливаю стек..."
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down
    ok "Стек остановлен."
    exit 0
    ;;
  restart)
    log "Перезапускаю без пересборки..."
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart
    ok "Перезапущено."
    exit 0
    ;;
  logs)
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs -f --tail=100
    exit 0
    ;;
  status)
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
    exit 0
    ;;
  update)
    log "Получаю обновления из git..."
    CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    PREVIOUS_HEAD="$(git rev-parse HEAD 2>/dev/null || true)"
    if [[ -z "$CURRENT_BRANCH" || "$CURRENT_BRANCH" == "HEAD" ]]; then
      die "Не удалось определить текущую git-ветку. Выполните update вручную."
    fi
    git fetch --all --prune
    git pull --ff-only origin "$CURRENT_BRANCH"
    prime_compose_interpolation_env
    prompt_and_save_telegram_token 1 || true
    CURRENT_HEAD="$(git rev-parse HEAD 2>/dev/null || true)"
    detect_update_services "${PREVIOUS_HEAD}..${CURRENT_HEAD}"

    # We always rebuild db-migrate (cheap — most layers are cached) and always
    # run it (drizzle's hash table deduplicates applied migrations, so repeat
    # runs on a caught-up schema are a no-op).  This guarantees that pending
    # migrations from any prior failed/skipped update are caught up
    # deterministically on every `./start.sh update`.
    if printf '%s\n' "${UPDATE_SERVICES[@]}" | grep -qx 'db-migrate'; then
      log "Пересборка образа миграций (без кэша)..."
      "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --no-cache db-migrate
    else
      log "Пересобираю образ миграций (кэшированно) — на всякий случай."
      "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build db-migrate
    fi

    log "Запускаю инфраструктуру (БД, Redis, MinIO)..."
    # НИКОГДА не используем 'down -v' — это удалит данные
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d db redis minio

    log "Жду готовности БД и применяю миграции (идемпотентно)..."
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up db-migrate --force-recreate

    log "Пересборка и запуск только затронутых сервисов: ${UPDATE_SERVICES[*]}"
    if ! "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --remove-orphans "${UPDATE_SERVICES[@]}"; then
      err "docker compose up не удался (см. выше)."
      sep
      log "Последние строки логов API (диагностика):"
      "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs api --tail 150 2>&1 || true
      exit 1
    fi

    log "Проверяю состояние сервисов после обновления..."
    if ! "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps >/dev/null 2>&1; then
      die "Сервисы не отвечают после update. Проверьте ./start.sh logs"
    fi

    # `${#arr[@]:-0}` is not valid bash — length and default-value cannot be
    # combined on the same expansion.  Check unbound/unset first.
    if [[ -n "${UPDATE_HINTS+x}" && ${#UPDATE_HINTS[@]} -gt 0 ]]; then
      for hint in "${UPDATE_HINTS[@]}"; do
        warn "$hint"
      done
    fi

    ok "Обновление завершено. Данные сохранены."
    exit 0
    ;;
  tg)
    [[ -f "$ENV_FILE" ]] || die "Не найден ${ENV_FILE}. Сначала выполните ./start.sh up"
    prime_compose_interpolation_env
    prompt_and_save_telegram_token 0
    log "Перезапускаю API для применения TELEGRAM_BOT_TOKEN..."
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate api
    ok "TELEGRAM_BOT_TOKEN применён."
    exit 0
    ;;
  backup)
    BACKUP_DIR="${ROOT}/backups"
    mkdir -p "$BACKUP_DIR"
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="${BACKUP_DIR}/db_${TIMESTAMP}.sql.gz"
    log "Создаю резервную копию базы данных..."
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
      exec -T db \
      pg_dump -U "$(val_for_key POSTGRES_USER)" "$(val_for_key POSTGRES_DB)" \
      | gzip > "$BACKUP_FILE"
    ok "Резервная копия: ${BACKUP_FILE}"
    ls -lh "$BACKUP_DIR"/*.sql.gz | tail -5
    exit 0
    ;;
  backup-secrets)
    [[ -f "$SECRETS_DONE" ]] || die "Секреты ещё не инициализированы. Сначала выполните ./start.sh install"
    mkdir -p "$SECRETS_BACKUP_DIR"
    chmod 700 "$SECRETS_BACKUP_DIR"
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    TMP_DIR=$(mktemp -d)
    ARCHIVE_BASENAME="deployment_secrets_${TIMESTAMP}"
    TAR_PATH="${TMP_DIR}/${ARCHIVE_BASENAME}.tar"
    OUT_PATH="${SECRETS_BACKUP_DIR}/${ARCHIVE_BASENAME}.tar.enc"

    log "Готовлю зашифрованный backup секретов..."
    cp -R "$SECRETS_DIR" "${TMP_DIR}/secrets"
    [[ -f "$ENV_FILE" ]] && cp "$ENV_FILE" "${TMP_DIR}/.env.prod"
    [[ -f "$MESH_ENV_FILE" ]] && cp "$MESH_ENV_FILE" "${TMP_DIR}/.env.mesh"

    BACKUP_ITEMS=("secrets")
    [[ -f "${TMP_DIR}/.env.prod" ]] && BACKUP_ITEMS+=(".env.prod")
    [[ -f "${TMP_DIR}/.env.mesh" ]] && BACKUP_ITEMS+=(".env.mesh")
    tar -C "$TMP_DIR" -cf "$TAR_PATH" "${BACKUP_ITEMS[@]}"

    read -rsp "  Пароль для шифрования backup: " BACKUP_PASSPHRASE
    echo ""
    [[ -n "$BACKUP_PASSPHRASE" ]] || die "Пустой пароль не допускается."
    read -rsp "  Повторите пароль: " BACKUP_PASSPHRASE_CONFIRM
    echo ""
    [[ "$BACKUP_PASSPHRASE" == "$BACKUP_PASSPHRASE_CONFIRM" ]] || die "Пароли не совпадают."

    openssl enc -aes-256-cbc -pbkdf2 -iter 250000 -salt \
      -in "$TAR_PATH" \
      -out "$OUT_PATH" \
      -pass "pass:${BACKUP_PASSPHRASE}"

    chmod 600 "$OUT_PATH"
    rm -rf "$TMP_DIR"
    unset BACKUP_PASSPHRASE BACKUP_PASSPHRASE_CONFIRM

    ok "Зашифрованный backup создан: ${OUT_PATH}"
    echo -e "  Храните его отдельно от сервера и отдельно от пароля к нему."
    exit 0
    ;;
  restore-secrets)
    ARCHIVE_PATH="${2:-}"
    [[ -n "$ARCHIVE_PATH" ]] || die "Укажите путь: ./start.sh restore-secrets <path-to-backup.tar.enc>"
    [[ -f "$ARCHIVE_PATH" ]] || die "Файл не найден: $ARCHIVE_PATH"

    warn "Восстановление перезапишет локальные ./secrets и может обновить ${ENV_FILE}/${MESH_ENV_FILE}."
    read -rp "  Продолжить? (type RESTORE): " CONFIRM_RESTORE
    [[ "$CONFIRM_RESTORE" == "RESTORE" ]] || die "Восстановление отменено."

    TMP_DIR=$(mktemp -d)
    TAR_PATH="${TMP_DIR}/restore.tar"
    read -rsp "  Пароль для расшифровки backup: " RESTORE_PASSPHRASE
    echo ""
    [[ -n "$RESTORE_PASSPHRASE" ]] || die "Пустой пароль не допускается."

    openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
      -in "$ARCHIVE_PATH" \
      -out "$TAR_PATH" \
      -pass "pass:${RESTORE_PASSPHRASE}" \
      || die "Не удалось расшифровать backup. Проверьте пароль и файл."

    tar -C "$TMP_DIR" -xf "$TAR_PATH"
    rm -rf "$SECRETS_DIR"
    mv "${TMP_DIR}/secrets" "$SECRETS_DIR"
    chmod 700 "$SECRETS_DIR"
    find "$SECRETS_DIR" -type f -exec chmod 600 {} \;
    [[ -f "${TMP_DIR}/.env.prod" ]] && cp "${TMP_DIR}/.env.prod" "$ENV_FILE"
    [[ -f "${TMP_DIR}/.env.mesh" ]] && cp "${TMP_DIR}/.env.mesh" "$MESH_ENV_FILE"
    rm -rf "$TMP_DIR"
    unset RESTORE_PASSPHRASE

    ok "Секреты восстановлены."
    echo -e "  Перед запуском проверьте DNS/IP параметры в ${ENV_FILE} и ${MESH_ENV_FILE}."
    exit 0
    ;;
  clean)
    echo ""
    warn "Это удалит ВСЕ данные: БД, файлы, TLS сертификаты, секреты, образы."
    read -rp "  Введите YES для подтверждения: " CONFIRM
    if [[ "$CONFIRM" != "YES" ]]; then
      echo "  Отменено."
      exit 0
    fi

    log "Останавливаю контейнеры..."
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "${ENV_FILE:-.env.prod}" down --remove-orphans 2>/dev/null || true
    "${DC[@]}" -f "$COMPOSE_FILE" --env-file "${ENV_FILE:-.env.prod}" rm -f 2>/dev/null || true

    log "Удаляю volumes..."
    for vol in forestmessenger_pgdata forestmessenger_redis_data forestmessenger_minio_data forestmessenger_caddy_data forestmessenger_caddy_config; do
      if docker volume inspect "$vol" >/dev/null 2>&1; then
        docker volume rm "$vol" && ok "Удалён volume: $vol" || warn "Не удалось удалить: $vol"
      else
        log "Volume $vol не существует, пропускаю."
      fi
    done

    log "Удаляю Docker образы..."
    docker rmi forestmessenger-api forestmessenger-web forestmessenger-db-migrate 2>/dev/null && ok "Образы удалены." || log "Образы уже удалены или не найдены."

    log "Удаляю секреты..."
    if [[ -d "./secrets" ]]; then
      rm -rf "./secrets"
      ok "Удалена папка ./secrets/"
    fi

    log "Удаляю .env.prod..."
    if [[ -f "$ENV_FILE" ]]; then
      rm -f "$ENV_FILE"
      ok "Удалён $ENV_FILE"
    fi

    echo ""
    ok "Готово. Запустите ./start.sh для свежего деплоя."
    exit 0
    ;;
  mesh)
    sep
    echo -e "${BLD}  OneToThree — Mesh Helper Launcher${NC}"
    sep
    warn "Текущая реализация mesh поднимает relay-role helper (TURN) как первый scale-out slice."
    warn "Финальная цель — role-based cluster mesh для relay/api/worker/db-replica ролей."

    command -v docker >/dev/null 2>&1 || die "Не найдена команда: docker."
    if docker compose version >/dev/null 2>&1; then
      MESH_DC=(docker compose)
    elif command -v docker-compose >/dev/null 2>&1; then
      MESH_DC=(docker-compose)
    else
      die "Docker Compose не найден."
    fi
    docker info >/dev/null 2>&1 || die "Docker демон не запущен."

    if [[ ! -f "$MESH_ENV_FILE" ]]; then
      [[ -f ".env.mesh.example" ]] || die "Не найден .env.mesh.example"
      cp ".env.mesh.example" "$MESH_ENV_FILE"
      warn "Создан ${MESH_ENV_FILE}. Заполните TURN_REALM, TURN_EXTERNAL_IP и TURN_PASSWORD."
      warn "Для полного cluster mesh используйте cluster_join_token и internal_api_signing_key из ./secrets."
      echo -e "  Затем повторите: ${BLD}./start.sh mesh${NC}"
      exit 0
    fi

    mesh_val_for_key() {
      local key="$1"
      local line val
      line=$(grep -E "^[[:space:]]*${key}=" "$MESH_ENV_FILE" 2>/dev/null | tail -n1 || true)
      [[ -z "$line" ]] && { echo ""; return; }
      val="${line#*=}"
      val="${val//$'\r'/}"
      val="${val#\"}" val="${val%\"}"
      echo "$val"
    }

    mesh_check_required() {
      local key="$1" hint="$2"
      local v
      v="$(mesh_val_for_key "$key")"
      if is_placeholder "$v"; then
        die "В ${MESH_ENV_FILE} не заполнен ${key}. ${hint}"
      fi
    }

    [[ -f "$MESH_COMPOSE_FILE" ]] || die "Не найден ${MESH_COMPOSE_FILE}"

    mesh_check_required TURN_REALM "Например: turn.example.com или ваш основной домен."
    mesh_check_required TURN_EXTERNAL_IP "Укажите публичный IP helper-ноды."
    mesh_check_required TURN_PASSWORD "Укажите тот же TURN password, который знают клиенты."
    mesh_check_required TURN_USERNAME "Обычно достаточно оставить turn."

    log "Запускаю helper-node mesh (TURN relay)..."
    "${MESH_DC[@]}" -f "$MESH_COMPOSE_FILE" --env-file "$MESH_ENV_FILE" up -d
    ok "Helper-node mesh запущен."
    echo ""
    echo -e "  ${BLD}Проверьте:${NC}"
    echo -e "    1. DNS helper TURN hostname указывает на эту ноду"
    echo -e "    2. Порты 3478/tcp+udp и 49152-65535/udp открыты"
    echo -e "    3. На основном сервере/клиенте TURN URL смотрит на helper-ноду"
    exit 0
    ;;
  up|"")
    : # продолжаем ниже
    ;;
  *)
    echo "Использование: ./start.sh [install|up|quick|tg|mesh|backup-secrets|restore-secrets <file>|stop|restart|logs|status|update|backup|clean|uninstall]"
    exit 1
    ;;
esac

# =============================================================================
# ПРОВЕРКА VOLUMES (данные НЕ удаляются при обновлении)
# =============================================================================
sep
echo -e "${BLD}  OneToThree — Production Launcher${NC}"
sep
log "Проверяю сохранность данных..."

# Имя compose-проекта: фиксируем на forestmessenger, как в docker-compose.prod.yml
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-forestmessenger}"

check_volume() {
  local vol_suffix="$1"
  local label="$2"
  local full_name="${COMPOSE_PROJECT}_${vol_suffix}"
  if docker volume inspect "$full_name" >/dev/null 2>&1; then
    ok "Volume ${label} существует — данные сохранены (${full_name})"
  else
    log "Volume ${label} будет создан при первом запуске (${full_name})"
  fi
}

check_volume "pgdata"       "ПостгреС БД"
check_volume "redis_data"   "Redis"
check_volume "minio_data"   "MinIO файлы"
check_volume "caddy_data"   "TLS сертификаты"
check_volume "caddy_config" "Caddy config"

# =============================================================================
# ОБНАРУЖЕНИЕ STALE VOLUMES (свежий клон + старые данные)
# =============================================================================
if [[ ! -f "$SECRETS_DONE" ]]; then
  STALE_VOLUMES=()
  for _vol_suffix in pgdata redis_data minio_data caddy_data caddy_config; do
    _full_name="${COMPOSE_PROJECT}_${_vol_suffix}"
    if docker volume inspect "$_full_name" >/dev/null 2>&1; then
      STALE_VOLUMES+=("$_full_name")
    fi
  done
  if [[ ${#STALE_VOLUMES[@]} -gt 0 ]]; then
    echo ""
    warn "Секреты не инициализированы, но найдены Docker volumes от предыдущего деплоя:"
    for _sv in "${STALE_VOLUMES[@]}"; do
      echo -e "    ${YEL}•${NC} $_sv"
    done
    echo ""
    warn "Новые секреты не совпадут со старыми данными в volumes."
    warn "Рекомендация: ${BLD}./start.sh clean${NC} для полного сброса."
    echo ""
    echo -ne "  Продолжить всё равно? (y/N): "
    read -r CONTINUE_STALE
    if [[ "$CONTINUE_STALE" != "y" && "$CONTINUE_STALE" != "Y" ]]; then
      echo "  Отменено. Запустите ${BLD}./start.sh clean${NC} для сброса."
      exit 0
    fi
  fi
fi

# =============================================================================
# DOCKER SECRETS — генерация при первом запуске
# =============================================================================

if [[ ! -f "$SECRETS_DONE" ]]; then
  sep
  log "Секреты не инициализированы. Запускаю генерацию..."
  echo ""
  if [[ -x "./generate-secrets.sh" ]]; then
    ./generate-secrets.sh
  else
    chmod +x ./generate-secrets.sh 2>/dev/null || true
    bash ./generate-secrets.sh
  fi
  if [[ ! -f "$SECRETS_DONE" ]]; then
    die "Генерация секретов не завершена. Проверьте generate-secrets.sh."
  fi
  ok "Docker secrets готовы."
else
  ok "Docker secrets уже инициализированы ($SECRETS_DIR/)."
fi

# ensure_secret_stub is defined above the command dispatcher — see the
# definition near the start of this file so it runs for every subcommand.

# =============================================================================
# ENV ФАЙЛ — создать из шаблона если нет
# =============================================================================
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f ".env.prod.example" ]] || die "Не найден .env.prod.example — репозиторий повреждён."
  cp ".env.prod.example" "$ENV_FILE"
  if [[ ! -f "$SECRETS_DONE" ]]; then
    echo ""
    warn "Создан ${ENV_FILE} из шаблона."
    warn "Откройте файл и заполните все строки с пометкой  ← ЗАПОЛНИ"
    echo ""
    echo -e "  ${BLD}nano ${ENV_FILE}${NC}   или   ${BLD}vim ${ENV_FILE}${NC}"
    echo ""
    echo -e "  Минимум что нужно заполнить:"
    echo -e "    ${YEL}POSTGRES_PASSWORD${NC}   — пароль базы данных"
    echo -e "    ${YEL}MINIO_ROOT_PASSWORD${NC} — пароль хранилища"
    echo -e "    ${YEL}TURN_EXTERNAL_IP${NC}    — IP сервера (curl -s ifconfig.me)"
    echo -e "    ${YEL}TURN_PASSWORD${NC}       — пароль TURN"
    echo -e "    ${YEL}NEXT_PUBLIC_TURN_PASSWORD${NC} — тот же пароль TURN"
    echo -e "    ${YEL}NEXT_PUBLIC_TURN_URLS${NC} — список fallback URL (turn/turns)"
    echo -e "    ${YEL}VAPID_SUBJECT${NC}       — ваш email"
    echo ""
    echo -e "  Остальное (JWT_SECRET, WEBHOOK_SECRET, VAPID ключи) ${GRN}генерируется автоматически${NC}."
    echo ""
    read -r -p "  Нажмите Enter когда заполнили .env.prod (или Ctrl+C для отмены)..." || true
  else
    ok "${ENV_FILE} создан — секреты будут синхронизированы автоматически."
  fi
fi

# =============================================================================
# СИНХРОНИЗАЦИЯ СЕКРЕТОВ В .env.prod ИЗ ./secrets/
# =============================================================================
if [[ -f "$SECRETS_DONE" ]] && [[ -f "$ENV_FILE" ]]; then
  sync_secret_to_env() {
    local secret_file="$1" env_key="$2"
    if [[ -f "$SECRETS_DIR/$secret_file" ]]; then
      local val
      val=$(cat "$SECRETS_DIR/$secret_file")
      local current
      current=$(val_for_key "$env_key")
      if is_placeholder "$current"; then
        update_key "$env_key" "$val"
        ok "${env_key} синхронизирован из secrets."
      fi
    fi
  }

  sync_secret_to_env "postgres_password"    "POSTGRES_PASSWORD"
  sync_secret_to_env "minio_root_password"  "MINIO_ROOT_PASSWORD"
  sync_secret_to_env "jwt_secret"           "JWT_SECRET"
  sync_secret_to_env "webhook_secret"       "WEBHOOK_SECRET"
  sync_secret_to_env "totp_wrap_key"        "TOTP_WRAP_KEY"
  sync_secret_to_env "turn_password"        "TURN_PASSWORD"
  sync_secret_to_env "turn_password"        "NEXT_PUBLIC_TURN_PASSWORD"
  sync_secret_to_env "cluster_join_token"   "CLUSTER_JOIN_TOKEN"
  sync_secret_to_env "internal_api_signing_key" "INTERNAL_API_SIGNING_KEY"
  sync_secret_to_env "backup_encryption_key" "BACKUP_ENCRYPTION_KEY"
  sync_secret_to_env "cors_origin"          "CORS_ORIGIN"
  sync_secret_to_env "acme_email"           "ACME_EMAIL"
  sync_secret_to_env "turn_external_ip"     "TURN_EXTERNAL_IP"
  sync_secret_to_env "vapid_subject"        "VAPID_SUBJECT"
  sync_secret_to_env "vapid_public_key"     "VAPID_PUBLIC_KEY"
  sync_secret_to_env "vapid_public_key"     "NEXT_PUBLIC_VAPID_PUBLIC_KEY"
  sync_secret_to_env "vapid_private_key"    "VAPID_PRIVATE_KEY"
  sync_secret_to_env "telegram_bot_token"   "TELEGRAM_BOT_TOKEN"
  if [[ -f "$SECRETS_DIR/domain" ]]; then
    DOMAIN_VAL=$(cat "$SECRETS_DIR/domain")
    current_api=$(val_for_key NEXT_PUBLIC_API_URL)
    if is_placeholder "$current_api" || [[ -z "$current_api" ]]; then
      update_key NEXT_PUBLIC_API_URL "https://api.${DOMAIN_VAL}"
      update_key NEXT_PUBLIC_WS_ORIGIN "https://api.${DOMAIN_VAL}"
      update_key COOKIE_DOMAIN ".${DOMAIN_VAL}"
      update_key MINIO_PUBLIC_URL "https://s3.${DOMAIN_VAL}"
      update_key MINIO_CORS_ORIGINS "https://${DOMAIN_VAL},https://www.${DOMAIN_VAL}"
      update_key NEXT_PUBLIC_TURN_URL "turn:turn.${DOMAIN_VAL}:3478"
      update_key NEXT_PUBLIC_TURN_URLS "$(build_turn_urls "turn.${DOMAIN_VAL}")"
      update_key TURN_URLS "$(build_turn_urls "turn.${DOMAIN_VAL}")"
      update_key LIVEKIT_URL "wss://lk.${DOMAIN_VAL}"
      update_key NEXT_PUBLIC_LIVEKIT_URL "wss://lk.${DOMAIN_VAL}"
      ok "Доменные переменные синхронизированы для ${DOMAIN_VAL}."
    fi
  fi
fi

# =============================================================================
# АВТОГЕНЕРАЦИЯ СЕКРЕТОВ
# =============================================================================
sep
log "Проверяю секреты..."

JWT=$(val_for_key JWT_SECRET)
if is_placeholder "$JWT"; then
  update_key JWT_SECRET "$(openssl rand -hex 32)"
  ok "JWT_SECRET сгенерирован."
fi

WH=$(val_for_key WEBHOOK_SECRET)
if is_placeholder "$WH"; then
  update_key WEBHOOK_SECRET "$(openssl rand -hex 32)"
  ok "WEBHOOK_SECRET сгенерирован."
fi

TOTP_WRAP=$(val_for_key TOTP_WRAP_KEY)
if [[ -z "${TOTP_WRAP:-}" ]] || is_placeholder "$TOTP_WRAP"; then
  NEW_TOTP_WRAP=$(openssl rand -hex 32)
  update_key TOTP_WRAP_KEY "$NEW_TOTP_WRAP"
  # Also write the Docker secret file so the mount exists for api container.
  if [[ -d "$SECRETS_DIR" ]]; then
    echo -n "$NEW_TOTP_WRAP" > "$SECRETS_DIR/totp_wrap_key"
    chmod 600 "$SECRETS_DIR/totp_wrap_key"
  fi
  ok "TOTP_WRAP_KEY сгенерирован (AES-256-GCM для шифрования TOTP секретов в БД)."
fi

TURN_PASS=$(val_for_key TURN_PASSWORD)
TURN_PUB_PASS=$(val_for_key NEXT_PUBLIC_TURN_PASSWORD)
if [[ -n "$TURN_PASS" ]] && ! is_placeholder "$TURN_PASS" && is_placeholder "$TURN_PUB_PASS"; then
  update_key NEXT_PUBLIC_TURN_PASSWORD "$TURN_PASS"
  ok "NEXT_PUBLIC_TURN_PASSWORD синхронизирован."
fi
TURN_USER=$(val_for_key TURN_USERNAME)
TURN_PUB_USER=$(val_for_key NEXT_PUBLIC_TURN_USERNAME)
if [[ -n "$TURN_USER" ]] && ! is_placeholder "$TURN_USER" && is_placeholder "$TURN_PUB_USER"; then
  update_key NEXT_PUBLIC_TURN_USERNAME "$TURN_USER"
  ok "NEXT_PUBLIC_TURN_USERNAME синхронизирован."
fi
TURN_PUB_URL=$(val_for_key NEXT_PUBLIC_TURN_URL)
TURN_PUB_URLS=$(val_for_key NEXT_PUBLIC_TURN_URLS)
if [[ -n "$TURN_PUB_URL" ]] && ! is_placeholder "$TURN_PUB_URL" && is_placeholder "$TURN_PUB_URLS"; then
  TURN_HOST_ONLY=$(echo "$TURN_PUB_URL" | sed -E 's|^turns?:/*||' | cut -d'?' -f1 | cut -d':' -f1)
  if [[ -n "$TURN_HOST_ONLY" ]]; then
    update_key NEXT_PUBLIC_TURN_URLS "$(build_turn_urls "$TURN_HOST_ONLY")"
    ok "NEXT_PUBLIC_TURN_URLS синхронизирован."
  fi
fi
TURN_URLS_VAL=$(val_for_key TURN_URLS)
if is_placeholder "$TURN_URLS_VAL" && ! is_placeholder "$TURN_PUB_URLS"; then
  update_key TURN_URLS "$TURN_PUB_URLS"
  ok "TURN_URLS синхронизирован из NEXT_PUBLIC_TURN_URLS."
fi

VPUB=$(val_for_key VAPID_PUBLIC_KEY)
VPRIV=$(val_for_key VAPID_PRIVATE_KEY)
if is_placeholder "$VPUB" || is_placeholder "$VPRIV"; then
  log "Генерирую VAPID ключи..."
  PUB="" PRIV="" KEYGEN_OK=false

  TMPKEY=$(mktemp)
  if openssl ecparam -name prime256v1 -genkey -noout -out "$TMPKEY" 2>/dev/null; then
    PRIV=$(openssl ec -in "$TMPKEY" -outform DER 2>/dev/null | tail -c +8 | head -c 32 | base64 | tr '+/' '-_' | tr -d '=\n')
    PUB=$(openssl ec -in "$TMPKEY" -pubout -outform DER 2>/dev/null | tail -c 65 | base64 | tr '+/' '-_' | tr -d '=\n')
  fi
  rm -f "$TMPKEY"

  if [[ -n "${PUB:-}" ]] && [[ -n "${PRIV:-}" ]]; then
    update_key VAPID_PUBLIC_KEY "$PUB"
    update_key VAPID_PRIVATE_KEY "$PRIV"
    update_key NEXT_PUBLIC_VAPID_PUBLIC_KEY "$PUB"
    ok "VAPID ключи сгенерированы (openssl)."
    KEYGEN_OK=true
  fi

  if [[ "$KEYGEN_OK" == false ]]; then
    log "openssl VAPID не удался, пробую Docker fallback..."
    TMPV=$(mktemp)
    if docker run --rm node:20-alpine sh -c \
      'npm install -g web-push --silent 2>/dev/null && web-push generate-vapid-keys --json 2>/dev/null' \
      >"$TMPV" 2>/dev/null; then
      JSON_LINE=$(grep -o '{.*}' "$TMPV" | tail -1 || true)
      PUB=$(echo "$JSON_LINE" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4 || true)
      PRIV=$(echo "$JSON_LINE" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4 || true)
      if [[ -n "${PUB:-}" ]] && [[ -n "${PRIV:-}" ]]; then
        update_key VAPID_PUBLIC_KEY "$PUB"
        update_key VAPID_PRIVATE_KEY "$PRIV"
        update_key NEXT_PUBLIC_VAPID_PUBLIC_KEY "$PUB"
        ok "VAPID ключи сгенерированы (docker)."
        KEYGEN_OK=true
      fi
    fi
    rm -f "$TMPV"
  fi

  if [[ "$KEYGEN_OK" == false ]]; then
    warn "VAPID генерация не удалась. Заполните вручную:"
    warn "  npx web-push generate-vapid-keys"
  fi
fi

LK_KEY=$(val_for_key LIVEKIT_API_KEY)
LK_SECRET=$(val_for_key LIVEKIT_API_SECRET)
if [[ -z "${LK_KEY:-}" ]] || is_placeholder "$LK_KEY"; then
  NEW_LK_KEY="devkey-$(openssl rand -hex 8)"
  update_key LIVEKIT_API_KEY "$NEW_LK_KEY"
  printf '%s' "$NEW_LK_KEY" > "$SECRETS_DIR/livekit_api_key"
  chmod 600 "$SECRETS_DIR/livekit_api_key"
  ok "LIVEKIT_API_KEY сгенерирован."
fi
if [[ -z "${LK_SECRET:-}" ]] || is_placeholder "$LK_SECRET"; then
  NEW_LK_SECRET="$(openssl rand -hex 32)"
  update_key LIVEKIT_API_SECRET "$NEW_LK_SECRET"
  printf '%s' "$NEW_LK_SECRET" > "$SECRETS_DIR/livekit_api_secret"
  chmod 600 "$SECRETS_DIR/livekit_api_secret"
  ok "LIVEKIT_API_SECRET сгенерирован."
fi

DB_URL=$(val_for_key DATABASE_URL)
if echo "$DB_URL" | grep -q "CHANGE_ME"; then
  PG_USER=$(val_for_key POSTGRES_USER)
  PG_PASS=$(val_for_key POSTGRES_PASSWORD)
  PG_DB=$(val_for_key POSTGRES_DB)
  if [[ -n "$PG_PASS" ]] && ! is_placeholder "$PG_PASS"; then
    update_key DATABASE_URL "postgres://${PG_USER:-forest}:${PG_PASS}@db:5432/${PG_DB:-forest}"
    ok "DATABASE_URL синхронизирован."
  fi
fi

TURN_EXT=$(val_for_key TURN_EXTERNAL_IP)
if is_placeholder "$TURN_EXT"; then
  TURN_AUTO="$(detect_public_ip || true)"
  if [[ -n "$TURN_AUTO" ]]; then
    update_key TURN_EXTERNAL_IP "$TURN_AUTO"
    ok "TURN_EXTERNAL_IP автоопределён (${TURN_AUTO})."
  else
    warn "Не удалось автоопределить TURN_EXTERNAL_IP. Заполните его вручную в ${ENV_FILE}."
  fi
fi

TURN_EXT=$(val_for_key TURN_EXTERNAL_IP)
if [[ -n "$TURN_EXT" ]] && ! is_placeholder "$TURN_EXT" && ! looks_like_ip "$TURN_EXT"; then
  die "TURN_EXTERNAL_IP должен быть IP-адресом, а не '${TURN_EXT}'."
fi

# =============================================================================
# ПРОВЕРКА ОБЯЗАТЕЛЬНЫХ ПОЛЕЙ
# =============================================================================
sep
log "Проверяю обязательные поля..."

MISSING=0

check_required() {
  local key="$1" hint="${2:-}"
  local val
  val=$(val_for_key "$key")
  if is_placeholder "$val"; then
    err "  ${key} не заполнен"
    [[ -n "$hint" ]] && echo -e "    ${DIM}↓ ${hint}${NC}"
    MISSING=1
  fi
}

check_required POSTGRES_PASSWORD      "Придумайте надёжный пароль для базы данных"
check_required MINIO_ROOT_PASSWORD    "Придумайте надёжный пароль для хранилища файлов"
check_required CORS_ORIGIN            "Домен сайта: https://onetothree.ru"
check_required TURN_EXTERNAL_IP       "Внешний IP TURN-реле (обычно определяется автоматически)"
check_required TURN_PASSWORD          "Придумайте пароль для TURN"
check_required VAPID_SUBJECT          "Ваш email: mailto:you@example.com"
check_required ACME_EMAIL             "Email для Let's Encrypt: admin@onetothree.ru"

if [[ "$MISSING" -ne 0 ]]; then
  echo ""
  err "Заполните отмеченные поля в ${ENV_FILE} и запустите снова."
  exit 1
fi

ok "Все обязательные поля заполнены."

# =============================================================================
# ПРОВЕРКА CLOUDFLARE / TURN
# =============================================================================
sep
CORS=$(val_for_key CORS_ORIGIN)
DOMAIN=$(echo "$CORS" | sed 's|https\?://||' | cut -d'/' -f1)
API_URL=$(val_for_key NEXT_PUBLIC_API_URL)
TURN_URL=$(val_for_key NEXT_PUBLIC_TURN_URL)
TURN_URLS=$(val_for_key NEXT_PUBLIC_TURN_URLS)
TURN_SAMPLE="${TURN_URL}"
if [[ -n "$TURN_URLS" ]] && ! is_placeholder "$TURN_URLS"; then
  TURN_SAMPLE="$(echo "$TURN_URLS" | cut -d',' -f1)"
fi
TURN_HOST=$(echo "$TURN_SAMPLE" | sed -E 's|^turns?:/*||' | cut -d'?' -f1 | cut -d: -f1)
API_HOST=$(echo "$API_URL" | sed 's|https\?://||' | cut -d/ -f1)

if [[ "$TURN_HOST" == "$API_HOST" ]]; then
  warn "TURN и API — один хост (${API_HOST})."
  warn "Если за Cloudflare — звонки не будут работать."
  warn "Создайте отдельную DNS запись turn.${DOMAIN} с 'DNS only' (серое облако)."
  warn "И установите NEXT_PUBLIC_TURN_URLS с fallback-цепочкой (turn+turns)."
else
  ok "TURN хост (${TURN_HOST}) отделён от API (${API_HOST}) — корректно."
fi

# =============================================================================
# СБОРКА И ЗАПУСК
# =============================================================================
sep
log "Запускаю стек..."
echo ""

prime_compose_interpolation_env

FIRST_RUN=false
if ! "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps --quiet 2>/dev/null | grep -q .; then
  FIRST_RUN=true
fi

if ! "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --remove-orphans; then
  err "docker compose up не удался (см. выше)."
  sep
  log "Последние строки логов API (диагностика):"
  "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs api --tail 150 2>&1 || true
  exit 1
fi

# =============================================================================
# ОЖИДАНИЕ ГОТОВНОСТИ
# =============================================================================

wait_healthy() {
  local service="$1" label="${2:-$1}" max_wait="${3:-120}"
  local elapsed=0 interval=3
  printf "  %-14s " "$label"

  local container
  container=$("${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q "$service" 2>/dev/null | head -1)

  if [[ -z "$container" ]]; then
    echo -e " ${YEL}⚠ не найден${NC}"
    return 1
  fi

  while true; do
    local health_status
    health_status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo "unknown")

    case "$health_status" in
      healthy)   echo -e " ${GRN}✓ healthy${NC}"; return 0 ;;
      unhealthy) echo -e " ${RED}✗ unhealthy${NC}"
                 docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' "$container" 2>/dev/null | tail -3
                 return 1 ;;
      running)
        echo -e " ${GRN}✓ running${NC}"; return 0 ;;
      starting)
        ;;
    esac

    sleep "$interval"
    elapsed=$((elapsed + interval))
    printf "."
    if [[ "$elapsed" -ge "$max_wait" ]]; then
      health_status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo "unknown")
      if [[ "$health_status" == "healthy" || "$health_status" == "running" ]]; then
        echo -e " ${GRN}✓ ${health_status}${NC}"
        return 0
      fi
      echo -e " ${YEL}⚠ timeout (${health_status})${NC}"
      return 1
    fi
  done
}

all_healthy=true
for svc in db redis minio api web; do
  cid=$("${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q "$svc" 2>/dev/null | head -1)
  if [[ -n "$cid" ]]; then
    st=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null)
    [[ "$st" != "healthy" && "$st" != "running" ]] && all_healthy=false
  fi
done

CADDY_TLS_WARNING=false
CADDY_TLS_LOG_MATCHES=""

if [[ "$all_healthy" == true ]]; then
  ok "Все сервисы запущены и здоровы."
else
  sep
  log "Жду готовности сервисов..."
  wait_healthy "db"    "ПостгреС"     60  || true
  wait_healthy "redis" "Redis"        60  || true
  wait_healthy "minio" "MinIO"        60  || true
  wait_healthy "api"   "API"          120 || true
  wait_healthy "web"   "Next.js"      180 || true
fi

if "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q caddy >/dev/null 2>&1; then
  CADDY_CID=$("${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q caddy 2>/dev/null | head -1)
  if [[ -n "${CADDY_CID:-}" ]]; then
    CADDY_TLS_LOG_MATCHES=$(docker logs "$CADDY_CID" --tail 200 2>&1 | grep -E "challenge failed|could not get certificate from issuer|Cannot negotiate ALPN protocol|Invalid response from http://.*521" || true)
    if [[ -n "$CADDY_TLS_LOG_MATCHES" ]]; then
      CADDY_TLS_WARNING=true
    fi
  fi
fi

# =============================================================================
# ФИНАЛ
# =============================================================================
sep
"${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
sep

TURN_RELAY_IP=$(val_for_key TURN_EXTERNAL_IP)

echo ""
if [[ "$CADDY_TLS_WARNING" == true ]]; then
  echo -e "${YEL}${BLD}  ⚠ Forest Messenger запущен, но HTTPS/TLS не подтверждён${NC}"
else
  echo -e "${GRN}${BLD}  ✓ Forest Messenger запущен${NC}"
fi
echo ""
echo -e "  ${BLD}Сайт:${NC}    ${CYN}${CORS}${NC}"
echo -e "  ${BLD}API:${NC}     ${CYN}${API_URL}${NC}"
if [[ -n "$TURN_RELAY_IP" ]]; then
  echo -e "  ${BLD}TURN relay IP:${NC} ${DIM}${TURN_RELAY_IP}${NC}"
fi
echo ""
echo -e "  ${DIM}./start.sh logs    — просмотр логов${NC}"
echo -e "  ${DIM}./start.sh stop    — остановить${NC}"
echo -e "  ${DIM}./start.sh update  — обновить${NC}"
echo -e "  ${DIM}./start.sh backup  — резервная копия БД${NC}"
echo -e "  ${DIM}./start.sh backup-secrets — зашифрованный backup секретов${NC}"
echo ""
echo -e "  ${DIM}Данные хранятся в Docker volumes и НЕ удаляются при обновлении.${NC}"
echo -e "  ${DIM}./start.sh clean   — полный сброс (ОСТОРОЖНО)${NC}"

if [[ "$FIRST_RUN" == true ]]; then
  echo ""
  echo -e "  ${YEL}Первый запуск: TLS сертификат получается автоматически (Let's Encrypt).${NC}"
  echo -e "  ${YEL}Убедитесь что порты 80/443 открыты и DNS указывает на этот сервер.${NC}"
fi
if [[ "$CADDY_TLS_WARNING" == true ]]; then
  echo ""
  echo -e "  ${YEL}Caddy сообщает об ошибках получения TLS-сертификата.${NC}"
  echo -e "  ${YEL}Проверьте DNS/Cloudflare и доступность 80/443, затем посмотрите: ./start.sh logs${NC}"
fi
echo ""
