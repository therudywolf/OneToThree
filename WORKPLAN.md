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
  - [x] этап 1.4 — финишный sweep по редким модалкам (`vault`, `identity`, `group settings`)

---

## SPRINT 3 — Стикеры и Emoji

### 3.1 Telegram стикеры — интеграция
- [x] Эндпоинты `GET /api/stickers/packs`, `POST /api/stickers/packs/import`, `GET .../packs/:id`, `GET .../stickers`, `GET /api/stickers/asset-url`
- [x] Клиент: `client/src/lib/api/stickers.ts`, отправка через `buildStickerPlaintext` → `sendText` (E2E JSON в plaintext)
- [x] Клиент: офлайн-кэш паков (localStorage TTL + fallback при сетевых ошибках)
- [x] Клиент: рендеринг TGS/Lottie (`lottie-web` + `pako` для tgs)
- [x] Envelope `p13: 'sticker'`, поле `path` = стабильный `media_key` (не presigned URL)

**Структура БД уже есть:** `sticker_packs`, `stickers` (migration 0031)

### 3.2 Кнопка emoji/sticker/gif
- [x] Компонент `ComposerPickerPanel` — вкладки Emoji | Stickers | GIF
- [x] Emoji: `emoji-picker-react`
- [x] Sticker: сетка по паку + импорт по short_name
- [x] GIF: Giphy search + вставка GIF URL в composer
- [x] Кнопка смайлика → composer (dock xl+ / модал на узких)

### Статус по запросу пользователя (2026-04-22)
- [x] Выполнен пункт 2 (GIF + TGS/Lottie + офлайн-кэш паков)
- [ ] Не приступал к остальным пунктам (Sprint 1, Sprint 4, Sprint 5, Sprint 6) в этом цикле

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
| GIF | Giphy Search API (`NEXT_PUBLIC_GIPHY_API_KEY`, fallback public beta key) |
| Emoji picker | `emoji-mart` (легковесная, React) |
| Lottie render | `lottie-web` + `pako` (gunzip `.tgs` → JSON) |
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
| 2026-04-22 | [x] UI task: этап 1.4 — `vault-modal`, `identity-modal`, `group-chat-settings` кнопки и поля приведены к единой высоте |
| 2026-04-22 | [x] Пункт 2: GIF (Giphy), TGS/Lottie renderer, офлайн-кэш sticker packs |
| 2026-04-22 | [x] Sidebar utility rail: в левую колонку добавлены нижние кнопки Settings / Notifications toggle / Vault lock + mobile-drawer поведение через `onNavigate` |
| 2026-04-22 | [x] Fix: исчезающие сообщения `[DECRYPT_FAIL]` после отправки — DR-контекст добавлен в history load + delivery sync (`use-load-chat-messages`, `use-message-delivery-sync`, `use-messages`) |

---

## AGENT HANDOFF (для следующих нейросетей)

- Последний интеграционный коммит по стикерам: `aff5c78`.
- Главный трекер: этот файл (`WORKPLAN.md`) + `AGENT_PROGRESS.md`.
- Уже закрыто технически: invite race, login ECDH upload, sticker composer/send/render (webp/webm/tgs/lottie), sticker asset-url, GIF search, offline sticker cache.
- Не закрыто: реальные e2e-баги из Sprint 1 (invites flow/messages/saved), DR send-path.
- Перед любыми крупными правками прогонять: `npm run typecheck`, `npm run lint`, `npm run test -w project-13-server`.

---

## Остатки и фрагменты (handoff delta, 2026-04-22)

### Что перепроверено в этом цикле
- [x] `npm run typecheck -w project-13-client` — PASS
- [x] `npm run lint -w project-13-client` — PASS
- [x] `npm run test -w project-13-server` — PASS (полный ран)
- [x] HAR-анализ проблемы «сообщение видно, потом пропадает»: подтверждён `protocol_version=2` + `dr:v2` + `dr_header`, корень в отсутствии `drCtx` на history/sync-пути

### Что закрыто прямо сейчас
- [x] Mobile UX: у списка чатов появился явный close-action (`X`) в drawer-header
- [x] Sidebar UX: внизу левой колонки добавлены Settings / Notifications toggle / Vault lock
- [x] Fix: для history load и pending delivery sync добавлен `drCtx`, чтобы DR v2 не деградировал в `[DECRYPT_FAIL]`

### Что остаётся следующей нейросети (приоритет)
1. [ ] Прогнать реальный e2e invites flow (`join/[code]`, некорректный code, `group_e2e` ключ)
2. [ ] Прогнать real-device runtime direct fanout (2+ устройства) и убедиться, что `[DECRYPT_FAIL]` не воспроизводится
3. [ ] Прогнать Saved Messages runtime (создание/перезагрузка/мульти-девайс)
4. [ ] Завершить DR send-path milestones (Sprint 5) и тестовое покрытие
5. [ ] TURN runtime проверка в боевом окружении (`/api/ice-servers`, coturn, fallback)

### Короткая обратная связь следующей нейросети
- Основной риск сейчас не в статике (линт/тайпы/юнит), а в runtime-переходах между путями доставки (REST/WS/sync/history).
- Если снова появится симптом «сообщение сначала видно, потом `[DECRYPT_FAIL]`», первым делом проверить, передаётся ли `drCtx` в конкретный decrypt-path.
- Мобильный UX стал лучше (добавлен явный выход из drawer), но нужен один живой touch-pass на телефоне, особенно с открытым поиском/модалками/доком.

---

## SPRINT 8 — HANDOFF TO CLAUDE (ЗАКРЫТО 2026-04-22)

### 8.1–8.5 — всё закрыто
- [x] `[DECRYPT_FAIL]` regression — `directPeerUserId` синхронно из `chats`, не async
- [x] MD3 chats not opening — та же корневая причина
- [x] MD3 left rail button sizes — `h-8 w-8 rounded-full`, иконки 18px
- [x] Sidebar action overlap — CSS `:first-child` fix, action buttons `width:36px; padding:0`
- [x] Theme isolation — shell rules строго в `[data-shell]`, palette в `[data-theme/palette]`
- [x] typecheck ✓ lint ✓ server tests 68/68 ✓

---

## SPRINT 9 — DUAL-THEME UI PARITY (активный)

> **Постоянное требование:** в проекте два независимых интерфейса — **MD3** (`data-shell="md3"`) и **Cyberpunk/Terminal** (`data-shell="terminal"`). Оба должны быть полностью отполированы и работать идеально. Любой UI/UX вклад обязан тестировать и поддерживать обе темы. Никаких утечек стилей между темами.

### Принципы изоляции тем

| Область | MD3 | Cyberpunk/Terminal |
|---------|-----|-------------------|
| Шрифт | Google Sans / Roboto | монопространственный (IBM Plex Mono / JetBrains) |
| Цвета | Material You dynamic palette | neon: cyan/green/magenta на тёмном фоне |
| Радиусы | скруглённые (rounded-full, rounded-xl) | прямоугольные/острые (rounded-none, rounded-sm) |
| Анимации | Material motion (ease-in-out) | CRT / glitch / scanlines |
| Иконки | Material Symbols | Lucide, ASCII-стиль |
| CSS-зона | `[data-shell="md3"]` | `[data-shell="terminal"]` |

### 9.1 MD3 — полировка

- [ ] Chat list item: аватар + имя + preview + badge + время — проверить все состояния
- [ ] Message bubbles: align (мои справа / чужие слева), timestamp + галочки
- [ ] Reply bubble: встроен в bubble, не отдельный блок
- [ ] Hover actions: Reply / React / Forward / Delete
- [ ] Desktop chat header: аватар + имя + online/last-seen + Search/Call/More
- [ ] Composer: Attach | Emoji+Sticker | поле | Send — проверить пропорции
- [ ] Micro-spacing: единый ритм отступов по всему интерфейсу
- [ ] Mobile: touch pass — drawer, composer, search overlay
- [ ] Входящие звонки, group call banner — визуальная проверка

### 9.2 Cyberpunk/Terminal — полировка

- [ ] Chat list: глитч-эффекты, CRT scanlines — работают корректно
- [ ] Terminal header: ASCII-разделители, monospace пропорции
- [ ] Message bubbles: стиль терминала, цвет нод (> you / > peer)
- [ ] Composer: стиль командной строки, cursor blink
- [ ] Hover actions: terminal-style (highlight без rounded)
- [ ] Mobile: проверить drawer в terminal shell (нет утечки MD3 стилей)
- [ ] CRT/vignette overlay: не ломает интерактивность на touch-устройствах

### 9.3 Общие / cross-theme задачи

- [ ] Safety numbers UI страница (одинаково в обоих шеллах, кастомизация по теме)
- [ ] TOFU warning при смене ключа собеседника (оба шелла)
- [ ] Sticker picker — проверить визуально в обоих шеллах
- [ ] GIF picker — проверить визуально в обоих шеллах
- [ ] Group call UI — работает в обоих шеллах
- [ ] Модалки (vault, identity, group settings) — проверить в обоих шеллах

---

## SPRINT 10 — RUNTIME E2E ВАЛИДАЦИЯ (активный)

### 10.1 Инвайты (join flow)
- [ ] `join/[code]` — корректный код, ошибочный код, истекший код
- [ ] `group_e2e`: `encrypted_group_key` передаётся при вступлении
- [ ] `public_open`: вступление без ключа

### 10.2 Direct fanout (2+ устройства)
- [ ] Отправить сообщение с устройства A, получить на устройстве B
- [ ] Убедиться что `[DECRYPT_FAIL]` не воспроизводится
- [ ] Проверить `DIRECT_FANOUT_UNAVAILABLE` при отсутствии ECDH-ключа

### 10.3 Saved Messages
- [ ] Создать/перезагрузить/прочитать — один аккаунт
- [ ] Мульти-девайс: написать с A, прочитать на B

### 10.4 DR send path (Sprint 5 — продолжение)
- [ ] `use-send-message` включить DR path при `NEXT_PUBLIC_DR_ENABLED=1`
- [ ] Server принимает `protocol_version:2` + `dr_header`
- [ ] Fallback v1 если нет DR bundle у собеседника

### 10.5 TURN / звонки
- [ ] `/api/ice-servers` возвращает HMAC-credentials
- [ ] coturn доступен и проксирует
- [ ] Fallback на STUN при недоступности coturn

