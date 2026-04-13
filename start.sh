#!/usr/bin/env bash
# =============================================================================
# OneToThree (Forest Messenger) — Production Launcher
# =============================================================================
# Первый запуск:
#   1. cp .env.prod.example .env.prod
#   2. Заполни .env.prod (только помеченные # ← ЗАПОЛНИ)
#   3. ./start.sh
#
# Последующие запуски:
#   ./start.sh          — обновить и перезапустить
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
    git pull origin ver2
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
  up|"")
    : # продолжаем ниже
    ;;
  *)
    echo "Использование: ./start.sh [up|stop|restart|logs|status|update|backup]"
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
# ENV ФАЙЛ — создать из шаблона если нет
# =============================================================================
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f ".env.prod.example" ]] || die "Не найден .env.prod.example — репозиторий повреждён."
  cp ".env.prod.example" "$ENV_FILE"
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
  TMPV=$(mktemp)
  KEYGEN_OK=false
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
      ok "VAPID ключи сгенерированы."
      KEYGEN_OK=true
    fi
  fi
  rm -f "$TMPV"
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
sep
log "Жду готовности сервисов..."

wait_healthy() {
  local service="$1" label="${2:-$1}" max_wait="${3:-120}"
  local elapsed=0 interval=5
  printf "  %-14s " "$label"
  while true; do
    STATUS=$("${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
      ps "$service" 2>/dev/null | grep -oE 'healthy|unhealthy|Up|Exit' | head -1 || true)
    case "$STATUS" in
      healthy) echo -e " ${GRN}✓ healthy${NC}"; return 0 ;;
      unhealthy) echo -e " ${RED}✗ unhealthy${NC}"; return 1 ;;
    esac
    sleep "$interval"
    elapsed=$((elapsed + interval))
    printf "."
    if [[ "$elapsed" -ge "$max_wait" ]]; then
      echo -e " ${YEL}⚠ timeout${NC}"
      return 1
    fi
  done
}

wait_healthy "db"    "PostgreSQL"  60  || true
wait_healthy "minio" "MinIO"       60  || true
wait_healthy "api"   "API"         120 || true
wait_healthy "web"   "Next.js"     180 || true

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
echo -e "  ${DIM}Для полного сброса (ОСТОРОЖНО): docker compose down -v${NC}"

if [[ "$FIRST_RUN" == true ]]; then
  echo ""
  echo -e "  ${YEL}Первый запуск: TLS сертификат получается автоматически (Let's Encrypt).${NC}"
  echo -e "  ${YEL}Убедитесь что порты 80/443 открыты и DNS указывает на этот сервер.${NC}"
fi
echo ""
