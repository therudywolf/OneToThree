#!/usr/bin/env bash
# =============================================================================
# OneToThree (Forest Messenger) — Production Launcher
# =============================================================================
# Первый запуск:
#   ./start.sh          — генерирует секреты (покажет пароли один раз), запускает стек
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

# =============================================================================
# КОМАНДЫ
# =============================================================================
CMD="${1:-up}"

case "$CMD" in
  stop)
    log "Останавливаю стек..."
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down
    ok "Стек остановлен."
    exit 0
    ;;
  restart)
    log "Перезапускаю без пересборки..."
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart
    ok "Перезапущено."
    exit 0
    ;;
  logs)
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs -f --tail=100
    exit 0
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
    exit 0
    ;;
  update)
    log "Получаю обновления из git..."
    git pull origin master
    log "Пересборка образов (данные в volumes сохраняются)..."
    # НИКОГДА не используем 'down -v' — это удалит данные
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --remove-orphans
    ok "Обновление завершено. Данные сохранены."
    exit 0
    ;;
  backup)
    BACKUP_DIR="${ROOT}/backups"
    mkdir -p "$BACKUP_DIR"
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="${BACKUP_DIR}/db_${TIMESTAMP}.sql.gz"
    log "Создаю резервную копию базы данных..."
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
      exec -T db \
      pg_dump -U "$(val_for_key POSTGRES_USER)" "$(val_for_key POSTGRES_DB)" \
      | gzip > "$BACKUP_FILE"
    ok "Резервная копия: ${BACKUP_FILE}"
    ls -lh "$BACKUP_DIR"/*.sql.gz | tail -5
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
    docker compose -f "$COMPOSE_FILE" --env-file "${ENV_FILE:-.env.prod}" down --remove-orphans 2>/dev/null || true
    docker compose -f "$COMPOSE_FILE" --env-file "${ENV_FILE:-.env.prod}" rm -f 2>/dev/null || true

    log "Удаляю volumes..."
    for vol in forestmessenger_pgdata forestmessenger_minio_data forestmessenger_caddy_data forestmessenger_caddy_config; do
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
  up|"")
    : # продолжаем ниже
    ;;
  *)
    echo "Использование: ./start.sh [up|stop|restart|logs|status|update|backup|clean]"
    exit 1
    ;;
esac

# =============================================================================
# ПРОВЕРКА ЗАВИСИМОСТЕЙ
# =============================================================================
sep
echo -e "${BLD}  OneToThree — Production Launcher${NC}"
sep

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
# ПРОВЕРКА VOLUMES (данные НЕ удаляются при обновлении)
# =============================================================================
sep
log "Проверяю сохранность данных..."

# Получаем имя проекта (по умолчанию — имя директории)
COMPOSE_PROJECT=$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '-' | sed 's/-$//')

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

check_volume "pgdata"      "PostgreSQL БД"
check_volume "minio_data"  "MinIO файлы"
check_volume "caddy_data"  "TLS сертификаты"
check_volume "caddy_config" "Caddy config"

# =============================================================================
# ОБНАРУЖЕНИЕ STALE VOLUMES (свежий клон + старые данные)
# =============================================================================
SECRETS_DIR="./secrets"
SECRETS_DONE="$SECRETS_DIR/.initialized"

if [[ ! -f "$SECRETS_DONE" ]]; then
  STALE_VOLUMES=()
  for _vol_suffix in pgdata minio_data caddy_data caddy_config; do
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

# =============================================================================
# ENV ФАЙЛ — создать из шаблона если нет
# =============================================================================
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f ".env.prod.example" ]] || die "Не найден .env.prod.example — репозиторий повреждён."
  cp ".env.prod.example" "$ENV_FILE"
  # Если секреты уже сгенерированы через generate-secrets.sh —
  # синхронизация произойдёт ниже автоматически, ручное заполнение не нужно.
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
# Если Docker secrets инициализированы, автозаполняем .env.prod для backward compat
# (coturn, web build args, and other services that still read from env file).
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
  sync_secret_to_env "turn_password"        "TURN_PASSWORD"
  sync_secret_to_env "turn_password"        "NEXT_PUBLIC_TURN_PASSWORD"
  sync_secret_to_env "cors_origin"          "CORS_ORIGIN"
  sync_secret_to_env "acme_email"           "ACME_EMAIL"
  sync_secret_to_env "turn_external_ip"     "TURN_EXTERNAL_IP"
  sync_secret_to_env "vapid_subject"        "VAPID_SUBJECT"
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

VPUB=$(val_for_key VAPID_PUBLIC_KEY)
VPRIV=$(val_for_key VAPID_PRIVATE_KEY)
if is_placeholder "$VPUB" || is_placeholder "$VPRIV"; then
  log "Генерирую VAPID ключи..."
  PUB="" PRIV="" KEYGEN_OK=false

  # Preferred: native openssl (fast, no network)
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

  # Fallback: docker node (slow, pulls ~40MB image)
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
    [[ -n "$hint" ]] && echo -e "    ${DIM}↳ ${hint}${NC}"
    MISSING=1
  fi
}

check_required POSTGRES_PASSWORD      "Придумайте надёжный пароль для базы данных"
check_required MINIO_ROOT_PASSWORD    "Придумайте надёжный пароль для хранилища файлов"
check_required CORS_ORIGIN            "Домен сайта: https://onetothree.ru"
check_required TURN_EXTERNAL_IP       "IP сервера: curl -s ifconfig.me"
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
TURN_HOST=$(echo "$TURN_URL" | sed 's|turn:||' | cut -d: -f1)
API_HOST=$(echo "$API_URL" | sed 's|https\?://||' | cut -d/ -f1)

if [[ "$TURN_HOST" == "$API_HOST" ]]; then
  warn "TURN и API — один хост (${API_HOST})."
  warn "Если за Cloudflare — звонки не будут работать."
  warn "Создайте отдельную DNS запись turn.${DOMAIN} с 'DNS only' (серое облако)."
  warn "И установите NEXT_PUBLIC_TURN_URL=turn:turn.${DOMAIN}:3478"
else
  ok "TURN хост (${TURN_HOST}) отделён от API (${API_HOST}) — корректно."
fi

# =============================================================================
# СБОРКА И ЗАПУСК
# =============================================================================
sep
log "Запускаю стек..."
echo ""

FIRST_RUN=false
if ! "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps --quiet 2>/dev/null | grep -q .; then
  FIRST_RUN=true
fi

"${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --remove-orphans

# =============================================================================
# ОЖИДАНИЕ ГОТОВНОСТИ
# =============================================================================

wait_healthy() {
  local service="$1" label="${2:-$1}" max_wait="${3:-120}"
  local elapsed=0 interval=3
  printf "  %-14s " "$label"

  # Get container ID for this service
  local container
  container=$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q "$service" 2>/dev/null | head -1)

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
        # Container has no healthcheck — treat running as ok
        echo -e " ${GRN}✓ running${NC}"; return 0 ;;
      starting)
        # Still starting, keep polling
        ;;
    esac

    sleep "$interval"
    elapsed=$((elapsed + interval))
    printf "."
    if [[ "$elapsed" -ge "$max_wait" ]]; then
      # Last check before timeout
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

# Quick pre-check: if compose up succeeded and all containers healthy, skip polling
all_healthy=true
for svc in db minio api web; do
  cid=$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q "$svc" 2>/dev/null | head -1)
  if [[ -n "$cid" ]]; then
    st=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null)
    [[ "$st" != "healthy" && "$st" != "running" ]] && all_healthy=false
  fi
done

if [[ "$all_healthy" == true ]]; then
  ok "Все сервисы запущены и здоровы."
else
  sep
  log "Жду готовности сервисов..."
  wait_healthy "db"    "PostgreSQL"  60  || true
  wait_healthy "minio" "MinIO"       60  || true
  wait_healthy "api"   "API"         120 || true
  wait_healthy "web"   "Next.js"     180 || true
fi

# =============================================================================
# ФИНАЛ
# =============================================================================
sep
"${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
sep

SERVER_IP=$(val_for_key TURN_EXTERNAL_IP)

echo ""
echo -e "${GRN}${BLD}  ✓ Forest Messenger запущен${NC}"
echo ""
echo -e "  ${BLD}Сайт:${NC}    ${CYN}${CORS}${NC}"
echo -e "  ${BLD}API:${NC}     ${CYN}${API_URL}${NC}"
echo -e "  ${BLD}Сервер:${NC}  ${DIM}${SERVER_IP}${NC}"
echo ""
echo -e "  ${DIM}./start.sh logs    — просмотр логов${NC}"
echo -e "  ${DIM}./start.sh stop    — остановить${NC}"
echo -e "  ${DIM}./start.sh update  — обновить${NC}"
echo -e "  ${DIM}./start.sh backup  — резервная копия БД${NC}"
echo ""
echo -e "  ${DIM}Данные хранятся в Docker volumes и НЕ удаляются при обновлении.${NC}"
echo -e "  ${DIM}./start.sh clean   — полный сброс (ОСТОРОЖНО)${NC}"

if [[ "$FIRST_RUN" == true ]]; then
  echo ""
  echo -e "  ${YEL}Первый запуск: TLS сертификат получается автоматически (Let's Encrypt).${NC}"
  echo -e "  ${YEL}Убедитесь что порты 80/443 открыты и DNS указывает на этот сервер.${NC}"
fi
echo ""
