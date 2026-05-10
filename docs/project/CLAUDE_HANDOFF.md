# CLAUDE HANDOFF — START HERE

Last updated: 2026-05-07

## Goal

Две независимые темы — MD3 и Cyberpunk/Terminal — должны работать идеально. Runtime-корректность первична. UI/UX полировка — второй приоритет, но обязательно для обоих шеллов.

## Source Of Truth

1. `ARCHITECTURE.md` — полная архитектура.
2. `FEATURE_MATRIX.md` — статус фич (актуально на 2026-05-07).
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

## Текущее состояние (2026-05-07, после rounds 2–7)

### Закрыто в rounds 2–7

- [x] GIF-превью в picker — прокси через `/api/gif/fetch`
- [x] Мульти-девайс расшифровка — `sender_ecdh_public_key_jwk` в WS broadcast; retry на upload ECDH ключа
- [x] Sidebar в коллапсированном режиме — overflow-hidden корректен
- [x] Скролл-движок — single rAF, sync snap при переключении чата
- [x] Стикеры: импорт из Telegram, Lottie/TGS плеер, toggle public/private, share-link
- [x] Double Ratchet v2 — всегда включён (флаг `NEXT_PUBLIC_DR_ENABLED` убран); send path → `encryptOutboundTextV2`
- [x] Polls (D1): DB schema (polls + poll_votes), server routes, client PollBubble, WS broadcast
- [x] Channels (D2): subscriber gating (`my_channel_role`), Megaphone icon, read-only bar, creation modal pre-selects channel tab
- [x] LiveKit call E2EE: `ExternalE2EEKeyProvider` + per-session HMAC-SHA256 room key

### Открытые задачи

#### Runtime / Инфраструктура

1. **Звонки TURNS:443** — P2P через TURN работает при открытых 3478 UDP/TCP. Для fallback через 443:
   - `turn.DOMAIN` в DNS должен быть **DNS only** (серое облако в Cloudflare)
   - Запустить `scripts/sync-turn-certs.sh` — копирует cert из Caddy volume в `./docker/coturn/tls/`
   - `docker compose restart coturn` — скрипт автоматически включит TLS
   - LiveKit SFU уже работает через 443 (Caddy → `lk.DOMAIN`); нужны `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` в secrets

2. **Polls migration** — после deploy нужно запустить `npm run db:push` или применить
   `server/src/db/migrations/0015_polls.sql` вручную.

3. **Деплой** — `./startup.sh update` на продакшене после каждого push.

#### UI / UX (оба шелла)

4. **Unread badge / open-on-tap** — push уведомления доставляются, но тап по notification
   не всегда открывает нужный чат. `FEATURE_MATRIX` строка: partial.

5. **PWA offline** — service worker зарегистрирован, outbox через Background Sync.
   Полный offline-режим (просмотр cached сообщений без сети) не реализован.

---

## Как деплоить на прод

```bash
# На сервере:
./startup.sh update

# Применить polls migration:
npm run db:push   # или docker exec -it db psql -f 0015_polls.sql

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
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit токены + E2EE ключи | нет (SFU disabled if absent) |
| `TURN_USERNAME` / `TURN_PASSWORD` | TURN credentials (lt-cred-mech) | да |
| `TURN_EXTERNAL_IP` | Публичный IP для coturn NAT traversal | да |
| `NEXT_PUBLIC_TURN_URLS` | TURN URL список для браузера | да |

## Критические правила разработки (из CLAUDE.md)

- **Никогда не используй Edit tool на файлах >300 строк с Windows-путём** — усекает файл.
  Всегда читай через `git show HEAD:path > /tmp/base`, патчи применяй через Python `str.replace()`.
- Оба шелла (MD3 + Terminal) тестируются после каждого UI изменения.
- `npm run db:push` после любых изменений в `schema.ts`.
