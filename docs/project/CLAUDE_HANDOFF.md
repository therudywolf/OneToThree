# CLAUDE HANDOFF — START HERE

Last updated: 2026-04-30 (post round6 sweep)

## Goal

Две независимые темы — MD3 и Cyberpunk/Terminal — должны работать идеально. Runtime-корректность первична. UI/UX полировка — второй приоритет, но обязательно для обоих шеллов.

## Source Of Truth

1. `ARCHITECTURE.md` — полная архитектура.
2. `FEATURE_MATRIX.md` — статус фич.
3. `CLAUDE.md` — правила разработки (прочти перед стартом!).

---

## КРИТИЧЕСКОЕ ТРЕБОВАНИЕ: Dual-theme

В проекте **два полностью независимых интерфейса**:

| Шелл | `data-shell` | Характер |
|------|-------------|----------|
| **MD3** | `"md3"` | Material Design 3 — Google Sans, скруглённые формы, динамические цвета |
| **Cyberpunk / Terminal** | `"terminal"` | Монопространственный, neon-цвета, CRT/glitch, ASCII-ритм |

**Правила:**
- Каждый UI/UX коммит тестируется в **обоих** шеллах.
- Стили изолированы строго: `[data-shell="md3"]` и `[data-shell="terminal"]`.
- `[data-theme="..."]` — только palette-токены, никаких компонентных правил.

---

## Текущее состояние (2026-04-30, после rounds 2–6)

### Закрыто в rounds 2–6

- [x] GIF-превью в picker — прокси через `/api/gif/fetch`
- [x] Мульти-девайс расшифровка — `sender_ecdh_public_key_jwk` в WS broadcast; retry на upload ECDH ключа
- [x] Sidebar в коллапсированном режиме — overflow-hidden корректен
- [x] Скролл-движок — single rAF, sync snap при переключении чата
- [x] Документы-«мусор» от AI удалены из git (`docs/audits/`, `docs/security-review/`)
- [x] coturn: `docker/coturn/entrypoint.sh` — TLS включается автоматически при наличии сертификатов, без него запускается в plain режиме
- [x] Стикеры: импорт из Telegram (настройки + picker), toggle public/private, share-link (`/stickers/add/[packId]`)
- [x] Ошибка `ECDSA_KEY_MISSING_IN_VAULT` при привязке устройства — внятное сообщение
- [x] `TELEGRAM_BOT_TOKEN` добавлен в `.env.prod.example` и `docker-compose.prod.yml`

### Открытые задачи

#### Runtime / Инфраструктура

1. **Звонки TURNS:443** — P2P через TURN работает при открытых 3478 UDP/TCP. Для fallback через 443:
   - `turn.DOMAIN` в DNS должен быть **DNS only** (серое облако в Cloudflare)
   - Запустить `scripts/sync-turn-certs.sh` — копирует cert из Caddy volume в `./docker/coturn/tls/`
   - `docker compose restart coturn` — скрипт автоматически включит TLS
   - LiveKit SFU уже работает через 443 (Caddy → `lk.DOMAIN`); для него нужны `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` в secrets

2. **Привязка устройства** — работает для vault v2+. LEGACY vault → понятное сообщение, нужно перерегистрироваться.

3. **Деплой** — `./start.sh update` на продакшене после каждого push.

#### UI / UX (оба шелла)

4. **Sticker Lottie player**: `.tgs` анимированные стикеры показываются как placeholder — Lottie/rlottie renderer не подключён.
5. **Safety numbers**: страница верификации в `identity-modal.tsx` — протестировать оба шелла.
6. **MD3**: message bubbles и hover actions — полировка не завершена.

#### Архитектура

7. **Double Ratchet send path**: send использует v1 fan-out. DR v2 только принимает. Для полного DR нужно переключить `encryptOutboundText` → `encryptOutboundTextV2` в send hooks — крупное изменение, отложено.

---

## Как деплоить на прод

```bash
# На сервере:
./start.sh update

# Включить TURNS после получения cert Caddy:
./scripts/sync-turn-certs.sh
docker compose -f docker-compose.prod.yml restart coturn
```

## Ключевые env переменные

| Переменная | Назначение | Обязательно |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Импорт стикер-паков из Telegram | нет |
| `GIPHY_API_KEY` | Поиск GIF | нет |
| `LIVEKIT_URL` | WSS URL LiveKit SFU | нет (P2P fallback) |
| `TURN_USERNAME` / `TURN_PASSWORD` | TURN credentials (lt-cred-mech) | да |
| `TURN_EXTERNAL_IP` | Публичный IP для coturn NAT traversal | да |
| `NEXT_PUBLIC_TURN_URLS` | TURN URL список для браузера | да |
