# WORKPLAN — OneToThree Bug Fixes & Feature Implementation

> Файл для отслеживания прогресса. Обновляется по мере работы.  
> Статус: `[ ]` — не начато | `[~]` — в процессе | `[x]` — выполнено | `[!]` — заблокировано

---

## SPRINT 1 — Критические баги (сообщения, инвайты, избранное)

### 1.1 Инвайты — DB-ошибка при создании
- [x] Все миграции применены (0034_chats_key_epoch, 0035_messages_pinned_and_muted — в DB)
- [x] `chats_invite_code_unique` — правильный UNIQUE INDEX, NULLs разрешены
- [x] Fix: race condition устранён (atomic update в `POST /:chatId/invite`)
- [ ] Проверить: роут `POST /:chatId/invite` возвращает правильный статус при ошибке

**Ключевые файлы:**
- `server/src/routes/chats.ts:818` — `POST /:chatId/invite`
- `server/src/routes/chats.ts:484` — `GET /join/:code`
- `server/src/db/schema.ts:165` — `chats.inviteCode` unique index
- `server/drizzle/` — все миграции

### 1.2 Инвайты — клиентский поток
- [ ] Проверить: `client/src/app/join/[code]/page.tsx` вызывает правильный URL
- [ ] Проверить: `client/src/lib/api/chats.ts:296` — `joinChatByInviteCode` 
- [ ] Проверить: группы типа `group_e2e` и `public_open` пропускаются через invite, `channel` — нет (намеренно)
- [ ] Исправить: после вступления не передаётся `encrypted_group_key` для `group_e2e` (критично для E2E)

### 1.3 Сообщения не работают
- [ ] Диагностировать: `DIRECT_FANOUT_UNAVAILABLE` (нет ECDH-ключа устройства) vs DB-ошибка
- [x] Fix: при login ECDH ключ повторно загружается (`PATCH /users/me`)
- [ ] Проверить: таблица `message_deliveries` — есть ли `device_id` и `ciphertext` колонки
- [ ] Проверить: WebSocket подключается и доставляет события
- [ ] Исправить: если ECDH key не загружается — починить поток vault unlock → ECDH upload

**Ключевые файлы:**
- `client/src/lib/fanout-crypto.ts` — `buildFanoutSlots`
- `client/src/lib/chat-message-transport.ts:83` — отправка
- `server/src/routes/messages.ts` — `POST /api/messages/send`
- `server/src/lib/chat-message-persist.ts` — `persistChatMessageAndFanOut`

### 1.4 Избранные сообщения (Saved Messages) не работают
- [ ] Диагностировать: `SELF_FANOUT_UNAVAILABLE` или ошибка расшифровки
- [ ] Проверить: `chat-crypto.ts:54` — self-chat определяется как `direct_e2e` с одним участником (мной)
- [ ] Проверить: `buildFanoutSlots` для SELF передаёт MY ECDH public key
- [ ] Исправить: если self-chat создаётся без ECDH key в `message_deliveries`

---

## SPRINT 2 — UI (Telegram Desktop-like)

### 2.1 Основной layout
- [ ] Sidebar: фиксированная ширина ~320px, список чатов с аватаром/именем/превью/временем
- [ ] Header чата: аватар + имя + статус (online/last seen), кнопки Search/Call/More
- [ ] Кнопки ввода: Attach | Emoji+Sticker | Input field | Send (как в TG Desktop)
- [ ] Папки/фильтры (уже есть rail) — проверить работу

### 2.2 Chat list item
- [ ] Показывать непрочитанные (badge)
- [ ] Preview последнего сообщения с типом (фото, стикер, голосовое)
- [ ] Pinned chats выводить вверху
- [ ] Muted — иконка mute

### 2.3 Message bubbles
- [ ] Align: my messages справа, чужие слева
- [ ] Timestamp + read receipt (галочки) в правом нижнем углу bubble
- [ ] Reply bubble встроен в сообщение (не отдельный блок)
- [ ] Hover actions: Reply, React, Forward, Delete

### 2.4 UI task (2026-04-22, user request)
- [x] Убрать пустой глобальный header на desktop (`chat-app` header скрыт на `md+`)
- [x] Сайдбар стартует от самого верха, без верхнего safe-padding на desktop (`md:pt-0`, `h:100dvh`)
- [x] Добавить верхний блок `ЧАТЫ` как первый элемент правой панели сайдбара (`top:0`, `sticky`)
- [~] Нормализация размеров кнопок:
  - [x] этап 1.1 — `chat-sidebar` (row-actions, direct input action, CTA-блок)
  - [x] этап 1.2 — `composer-picker-panel` + `chat-terminal` (единые `h-9/h-10` для tab/import/CTA/scroll button)
  - [x] этап 1.3 — mobile header chips + modal controls (`chat-search-panel`, `forward-modal`) унифицированы
  - [ ] этап 1.4 — финишный sweep по редким модалкам (`vault`, `identity`, `group settings`) для полной консистентности

---

## SPRINT 3 — Стикеры и Emoji

### 3.1 Telegram стикеры — интеграция
- [x] Эндпоинты `GET /api/stickers/packs`, `POST /api/stickers/packs/import`, `GET .../packs/:id`, `GET .../stickers`, `GET /api/stickers/asset-url`
- [x] Клиент: `client/src/lib/api/stickers.ts`, отправка через `buildStickerPlaintext` → `sendText` (E2E JSON в plaintext)
- [ ] Клиент: офлайн-кэш паков (сейчас загрузка по вкладке)
- [ ] Клиент: рендеринг TGS/Lottie (сейчас fallback: emoji + метка; static/webm — img/video)
- [x] Envelope `p13: 'sticker'`, поле `path` = стабильный `media_key` (не presigned URL)

**Структура БД уже есть:** `sticker_packs`, `stickers` (migration 0031)

### 3.2 Кнопка emoji/sticker/gif
- [x] Компонент `ComposerPickerPanel` — вкладки Emoji | Stickers | GIF (GIF — заглушка)
- [x] Emoji: `emoji-picker-react`
- [x] Sticker: сетка по паку + импорт по short_name
- [ ] GIF: Tenor / Giphy
- [x] Кнопка смайлика → composer (dock xl+ / модал на узких)

---

## SPRINT 4 — Звонки (TURN)

### 4.1 Диагностика
- [ ] Проверить: эндпоинт `GET /api/ice-servers` существует и возвращает TURN credentials
- [ ] Проверить: `docker/coturn/turnserver.conf` — правильные порты и realm
- [ ] Проверить: coturn запущен и доступен

### 4.2 Фикс
- [ ] `GET /api/ice-servers` должен возвращать coturn HMAC-credentials (time-limited)
- [ ] Формат: `{ iceServers: [{ urls: ['turn:...', 'turns:...'], username, credential }] }`
- [ ] Если coturn недоступен — добавить fallback на публичные STUN (уже в `ice-servers.ts`)
- [ ] Для разработки: добавить `.env.local` пример с TURN_SECRET

---

## SPRINT 5 — Double Ratchet (полная реализация)

### 5.1 Завершить send path
- [ ] `use-send-message.ts` — включить DR path для DIRECT чатов при `NEXT_PUBLIC_DR_ENABLED=1`
- [ ] `sendChatMessageOverTransport` — добавить DR mode: `encryptOutboundTextV2` → DR slots
- [ ] `server/src/routes/messages.ts` — принимать `protocol_version: 2` + `dr_header`
- [ ] Fallback: если у собеседника нет DR bundle → v1 fanout

### 5.2 Session bootstrap
- [ ] `dr-bootstrap.ts` — проверить что `publishLocalBundle` вызывается при vault unlock
- [ ] `session-manager.ts:bootstrapSession` — вызывать автоматически перед первым DR-сообщением
- [ ] Обработка `DR_INIT` сообщения (существующий механизм `messages.dr_init`)

### 5.3 Key rotation & safety numbers UI
- [ ] Страница верификации безопасных номеров в настройках чата
- [ ] Rotate signed prekey при необходимости (> 7 дней)
- [ ] Предупреждение если identity key собеседника изменился (TOFU)

### 5.4 Group DR (sender keys) — DEFERRED
- [ ] `sender-keys.ts` уже удалён (commit b40373e) — восстановить если нужно

---

## SPRINT 6 — Криптобезопасность (из аудита)

### 6.1 Vault
- [x] Vault v4 Argon2id реализован (фаза 1.5)
- [ ] Проверить: `upgradeVaultBlob` вызывается при первом unlock после обновления
- [ ] Проверить: PBKDF2 v1-v3 blobs корректно апгрейдятся

### 6.2 ECDH key management
- [ ] Проверить: device revoke действительно зачищает ключ из `message_deliveries`
- [ ] Проверить: при удалении устройства — старые delivery slots удаляются
- [ ] Forward secrecy для v1 fanout: при смене ECDH key старые сессии не расшифровать (OK, не проблема)

### 6.3 Trust store / TOFU
- [ ] `trust-store.ts` — DJB2 checksum слабый, рассмотреть SHA-256
- [ ] При изменении ECDH key — предупреждать пользователя

### 6.4 API security
- [ ] Проверить: все sensitive routes имеют TOTP step-up где нужно
- [ ] Проверить: rate limits на auth routes достаточны

---

## SPRINT 7 — Прочие фиксы из предыдущего анализа (CLAUDE.md improvements)

### 7.1 DB schema consistency
- [ ] Добавить в CLAUDE.md: vault v4 Argon2id, channel type, stickers tables
- [ ] Добавить в CLAUDE.md: `GET /api/messages/search` = 410 Gone
- [ ] Добавить в CLAUDE.md: `public_open` = plaintext

### 7.2 Message search (уже 410 Gone)
- [x] Server endpoint возвращает 410 (фаза 1.5)
- [x] Client использует `use-local-search` + IndexedDB
- [ ] Проверить: `use-local-search` hook существует и работает

---

## Ключевые технические решения

| Тема | Решение |
|------|---------|
| Стикеры TG | Bot API `getFile` → скачать TGS → загрузить в MinIO → хранить `media_key` |
| GIF | Tenor API (бесплатный, без ключа в dev) |
| Emoji picker | `emoji-mart` (легковесная, React) |
| Lottie render | `@lottiefiles/dotlottie-web` (поддерживает TGS) |
| TURN fallback | При недоступности coturn → Google STUN (уже в `ice-servers.ts`) |
| DR send path | Feature flag `NEXT_PUBLIC_DR_ENABLED=1`, fallback v1 если нет bundle |

---

## Лог работы

| Дата | Что сделано |
|------|-------------|
| 2026-04-22 | Создан WORKPLAN.md, проведён анализ кодовой базы |
| 2026-04-22 | [x] Fix: scrypt maxmem в recovery-key.ts (N=131072 требует 128MB, Node даёт 32MB) |
| 2026-04-22 | [x] Fix: lint errors в chat-sidebar.tsx (upsertChatFolder unused, renamingFolderId/Name unused) |
| 2026-04-22 | Диагностика: БД доступна (postgres:5432), схема полная. 0 устройств = тестовые пользователи, не через UI. |
| 2026-04-22 | Диагностика: ice-servers эндпоинт СУЩЕСТВУЕТ. Нужно настроить TURN_URLS/TURN_AUTH_SECRET в server/.env |
| 2026-04-22 | Диагностика: все 68 тестов проходят после scrypt-фикса |
| 2026-04-22 | [x] Стикеры: UI `ComposerPickerPanel`, `StickerBubble`, `GET /stickers/asset-url`, фикс `getLastCachedMessageForChat` IDBKeyRange (`\\uffff`) |
| 2026-04-22 | [x] Импорт TG: dedup по `(tg_source, owner_id)` на сервере |
| 2026-04-22 | [x] Верификация: `npm run test -w project-13-server` (68/68), `npm run lint`, `npm run typecheck` — зелёные |
| 2026-04-22 | [x] UI task: desktop header скрыт, sidebar поднят к верхнему краю (`top:0`, `100dvh`), добавлен верхний блок `ЧАТЫ` |
| 2026-04-22 | [x] UI task: унификация размеров кнопок в сайдбаре (h-10 для CTA/input-action, w-10 для row-action) |
| 2026-04-22 | [x] UI task: этап 1.2 унификации кнопок — composer tabs/import controls/scroll-to-bottom button |
| 2026-04-22 | [x] UI task: этап 1.3a — mobile header chips в `chat-app` приведены к единой высоте (`h-9`) |
| 2026-04-22 | [x] UI task: этап 1.3b — modal/action controls (`chat-search-panel`, `forward-modal`) приведены к `h-8/h-10` |

---

## AGENT HANDOFF (для следующих нейросетей)

- Последний интеграционный коммит по стикерам: `949f3eb`.
- Главный трекер: этот файл (`WORKPLAN.md`) + `AGENT_PROGRESS.md`.
- Уже закрыто технически: invite race, login ECDH upload, sticker composer/send/render (webp/webm), sticker asset-url.
- Не закрыто: реальные e2e-баги из Sprint 1 (invites flow/messages/saved), GIF API, TGS/Lottie renderer, DR send-path.
- Перед любыми крупными правками прогонять: `npm run typecheck`, `npm run lint`, `npm run test -w project-13-server`.

