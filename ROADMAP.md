# OneToThree — Roadmap незакрытых задач

> Файл создан 2026-04-22. Обновляется вручную или агентом после каждого значимого закрытия.
>
> Статусы: `[ ]` не начато · `[~]` в процессе · `[x]` закрыто · `[!]` заблокировано · `[–]` отложено/deferred

---

## Легенда приоритетов

| Метка | Смысл |
|-------|-------|
| 🔴 **CRITICAL** | Нарушает заявленную модель безопасности |
| 🟠 **HIGH** | Заявлено в концепте, не реализовано |
| 🟡 **MEDIUM** | Нужно для production-ready; UX/feature completeness |
| 🟢 **LOW** | Полировка, QoL, отложенные фичи |

---

## A — Безопасность (security gaps)

### A1 🔴 Group E2E invite: encrypted_group_key не передаётся новому участнику
**Статус:** `[x]` закрыто 2026-04-22

**Проблема:** При join через invite-code (`GET /chats/join/:code`) сервер вставляет строку в `chat_members` с `encryptedGroupKey: null`. Новый участник не может расшифровать ни одно сообщение — ни историческое, ни новое. При `group_e2e` это полный разрыв E2EE при любом вступлении в группу.

**Где:** `server/src/routes/chats.ts` строка ~530 (`encryptedGroupKey: null` в insert).

**План:**
1. Сервер при join возвращает список текущих участников с их ECDH публичными ключами.
2. Клиент (join-страница `client/src/app/join/[code]/page.tsx`) после успешного join запрашивает участников, берёт группового ключа от любого онлайн-участника (или получает его через отдельный механизм handshake).
3. Альтернативный подход (проще): при join клиент сразу передаёт `encrypted_group_key` — сервер должен потребовать его от `group_e2e` чатов. Требует временного ключа от одного из админов.
4. Добавить роут `POST /chats/:id/deliver-group-key` — существующий участник шифрует групповой ключ для нового и пушит его (WS-событие + REST fallback).
5. Тест: клиент A создаёт группу, клиент B вступает по invite, B может отправить и получить сообщение.

---

### A2 🔴 Trust store: DJB2 → SHA-256
**Статус:** `[x]` закрыто 2026-04-22

**Проблема:** `client/src/lib/trust-store.ts:24` использует DJB2 как контрольную сумму pinned-ключей. DJB2 — не криптографический хеш. Злонамеренная подмена ключа, дающая тот же DJB2, не будет обнаружена.

**Где:** `client/src/lib/trust-store.ts` функции `djb2Hex` и checksum usage.

**План:**
1. Заменить `djb2Hex` на `crypto.subtle.digest('SHA-256', ...)` (уже доступен в браузере без зависимостей).
2. Обновить `pinPeerKey` и `verifyPeerKey` — вычисление checksum теперь async.
3. Миграция данных: при первом чтении старого реестра (версия без `v` поля) пересчитать checksum по SHA-256, перезаписать.
4. Тест: убедиться что collision-атака через подмену ключа с тем же DJB2 вызывает `SECURITY_SIGNAL_MISMATCH`.

---

### A3 🔴 Call E2EE: SFU видит plaintext
**Статус:** `[–]` (deferred, архитектура задокументирована в MIGRATION_NOTES фаза 4.3)

**Проблема:** DTLS-SRTP шифрует транспорт клиент↔LiveKit, но сам SFU получает плейнтекст медиапотока. Это не E2EE по определению — оператор LiveKit-сервера видит аудио/видео.

**Где:** `MIGRATION_NOTES.md` фаза 4.3. Зависит от A4 (LiveKit подключение).

**План (фаза 4.3):**
1. После join звонка клиент запрашивает sender-key для комнаты через ratchet.
2. `Room.options.e2ee = true` с `ExternalE2EEKeyProvider` (LiveKit Insertable Streams).
3. Ключ = `HKDF(roomId, sender-key-secret)`, 32 байта.
4. При ротации (participant join/leave) → `ratchetKey` через `localParticipant.publishData`.
5. Зависимости: установить `@livekit/client` + `@livekit/e2ee-client`.
6. Текущий mesh P2P (без SFU) уже использует DTLS-SRTP между браузерами — это приемлемо для 1:1 звонков.

---

### A4 🟠 DR: NEXT_PUBLIC_DR_ENABLED не включён по умолчанию
**Статус:** `[x]` закрыто 2026-04-22

**Проблема:** DR send path реализован и подключён (`use-send-message.ts` → `encryptOutboundTextV2` → `encryptForPeer`). Но `dr-bootstrap.ts` не публикует bundle без флага `NEXT_PUBLIC_DR_ENABLED=1`. Без bundle → `RATCHET_NO_SESSION` → всегда v1 fan-out. Значит perfect forward secrecy не работает ни у одного пользователя.

**Где:** `client/src/lib/ratchet/dr-bootstrap.ts:32` — `DR_ENABLED` флаг.

**План:**
1. Убрать флаг из `dr-bootstrap.ts` — bootstrap запускается всегда при vault unlock.
2. Убедиться что `runDrBootstrap()` вызывается в `use-vault-unlock.ts` / vault-modal после разблокировки.
3. Проверить что OPK replenish (`< 5 remaining`) срабатывает корректно.
4. E2E тест: два аккаунта → первый обмен сообщением → убедиться `protocol_version=2` в network tab.
5. Rollback: добавить server-side флаг в `.env.prod`, а не клиентский env.

---

## B — Feature completion (заявлено, не реализовано)

### B1 🟠 Channels: UI создания, публикации, подписки
**Статус:** `[x]` закрыто 2026-04-22: server enforcement + ExploreModal + `createChannelChat()` API + `create-group-modal` переключён на `type: 'channel'` при `createMode === 'channel'`.

**Проблема:** `chat_type = 'channel'` есть в DB enum (миграция 0029/0030), `channel_role` схема есть. Но:
- ~~Нет серверного enforcement~~ — ЗАКРЫТО: `CHANNEL_SUBSCRIBERS_CANNOT_POST` в POST /messages/send.
- ~~Нет discovery feed~~ — ЗАКРЫТО: GET /chats/discover + ExploreModal.
- Нет UI подписки без invite (пока через Explore → Join).
- `create-group-modal.tsx` уже имеет `createMode === 'channel'`, но создаёт `public_open`, не `channel`.

**Где:** `server/src/routes/chats.ts`, `client/src/components/chat/create-group-modal.tsx`, новый компонент channel-feed.

**План:**
1. Server: добавить middleware на `POST /messages/send` — для `channel` чата постить может только `channel_role = 'owner'` или `'editor'`.
2. Server: `GET /chats/public` — публичный список каналов с пагинацией (discovery).
3. Client: `create-group-modal` — `createMode === 'channel'` должен создавать `type: 'channel'`, не `public_open`.
4. Client: channel-feed компонент — список каналов с поиском, кнопка подписки.
5. Client: в sidebar канал отображается с иконкой громкоговорителя, счётчиком подписчиков.
6. Тест: создать канал → подписаться → опубликовать пост → получить в ленте подписчика.

---

### B2 🟠 Public group discovery
**Статус:** `[x]` закрыто 2026-04-22 (7b3a9da): GET /chats/discover + ExploreModal + discoverChats() API

**Проблема:** `public_open` тип существует, используется. Но нет UI для обнаружения публичных групп (browse/search).

**Где:** `server/src/db/schema.ts` — `chats_channel_public_idx` индекс уже есть.

**План:**
1. Server: `GET /chats/discover?q=&limit=&offset=` — возвращает `public_open` и `channel` чаты с member count.
2. Client: страница/модал "Explore" — поиск + список публичных групп и каналов.
3. Интегрировать в sidebar (кнопка "Найти группы" → открывает explore modal).

---

### B3 🟠 Member roles / moderation UI для групп
**Статус:** `[x]` уже было реализовано: `group-chat-settings.tsx` содержит kick, reassignAuthority, setChannelFeedRole; server routes PATCH/DELETE /chats/:id/members/:userId существуют.

**Проблема:** `channel_role` enum есть в DB и схеме. Но:
- ~~Нет API для назначения роли~~ — PATCH /chats/:id/members/:userId/role реализован.
- ~~Нет UI управления участниками~~ — group-chat-settings.tsx содержит kick, promote to admin/owner.
- ~~Group settings modal не имеет вкладки участников~~ — реализовано.

**Где:** `server/src/routes/chats.ts`, `client/src/components/chat/group-chat-settings-modal.tsx`.

**План:**
1. Server: `PATCH /chats/:id/members/:userId` — обновить роль (только owner/admin может).
2. Server: `DELETE /chats/:id/members/:userId` — кик (только admin+).
3. Client: вкладка "Members" в group settings — список участников с ролями + контекстное меню.
4. Client: в message bubble → long-press/right-click → "Remove from group" (admin only).

---

### B4 🟠 LiveKit SFU: подключение к Call UI
**Статус:** `[x]` уже реализовано: use-webrtc.ts `trySfuFallback()` подключается к LiveKit когда `livekit_enabled && livekit_url`. Токен-роут call.ts реализован.

**Проблема:** LiveKit сервер работает, `POST /api/call/token` выдаёт JWT, но Call UI (`group-call-screen.tsx`, `active-call-overlay.tsx`) использует только mesh WebRTC. При 3+ участниках это N×N потоков — неприемлемо.

**Где:** `client/src/components/call/group-call-screen.tsx`, `client/src/lib/call-*.ts`.

**План:**
1. При группе ≥ 3 участников → использовать LiveKit путь; 1:1 → оставить P2P mesh.
2. Установить `@livekit/client` в client deps.
3. Создать `lib/livekit-call.ts` — обёртка над `Room` с join/leave/pub/sub.
4. `group-call-screen.tsx` — добавить ветку: если `NEXT_PUBLIC_LIVEKIT_URL` задан и участников ≥ 3 → `LiveKitRoom`.
5. Тест: 3 участника → звонок → видео идёт через SFU, не через mesh.

---

### B5 🟠 Sticker import: Bot API pipeline
**Статус:** `[x]` уже реализовано: stickers.ts использует tgApiGet + downloadTgFile, env TELEGRAM_BOT_TOKEN опциональный (503 если нет).

**Проблема:** `POST /api/stickers/packs/import` принимает `short_name`, но не скачивает TGS через Bot API. Таблица `sticker_packs.tg_source` есть, но import endpoint не делает реального fetch с Telegram.

**Где:** `server/src/routes/stickers.ts:258` — import route.

**План:**
1. Server: env `TELEGRAM_BOT_TOKEN` (опционально). Если не задан — import отдаёт 503.
2. Server: `importTelegramStickerPack(short_name)` — вызывает `getFile` Bot API → скачивает TGS → загружает в MinIO → сохраняет `media_key` в `stickers`.
3. Client: UI импорта уже есть (поле short_name в picker). Добавить progress-индикатор и сообщение об ошибке "Требуется Telegram Bot Token".
4. Тест: импортировать публичный пак → лотти-стикеры рендерятся в picker.

---

### B6 🟡 Web Push: полировка unread badge и open-on-tap
**Статус:** `[x]` верифицировано 2026-04-22: все три пункта уже реализованы. `push-handler.js` → `openWindow('/?chat=chatId')`; `chat-app.tsx` читает `?chat=` из searchParams; `useAppBadge` вызывает `navigator.setAppBadge(unreadTotal)`. `useNotificationOpen` обрабатывает SW-сообщения для открытых вкладок.

**Проблема:**
- Unread badge (PWA app icon badge) не всегда синхронизирован с реальным unread count.
- Тап по пуш-уведомлению не всегда открывает нужный чат (особенно если PWA закрыта).
- `unreadStore` и `notificationStore` иногда расходятся.

**Где:** `client/src/hooks/use-notifications.ts`, `client/public/push-handler.js`.

**План:**
1. `push-handler.js` при `notificationclick` → `clients.openWindow('/?chat=:chatId')`.
2. `client/src/app/page.tsx` → на mount считывать `?chat=` из URL и открывать чат.
3. `navigator.setAppBadge(unreadCount)` вызывать при изменении `unreadStore`.
4. Тест: получить push с закрытым PWA → тап → PWA открывается на нужном чате.

---

### B7 🟡 Safety numbers UI страница
**Статус:** `[x]` закрыто 2026-04-22

**Проблема:** `safety-number.ts` реализован (60-значный SHA-512 fingerprint), но нет UI для его показа и out-of-band верификации с собеседником.

**Где:** `client/src/lib/ratchet/safety-number.ts`, нужен новый компонент.

**План:**
1. В info-панели чата (или в identity modal) — кнопка "Verify Safety Number".
2. Показывает 60-значный номер, разбитый на 12 блоков по 5 цифр.
3. QR-код для быстрого сравнения (оба сканируют QR друг друга).
4. При несовпадении — TOFU-предупреждение уже есть; связать с safety numbers.

---

## C — UX bugs (подтверждённые, видны визуально)

### C1 🟡 Sidebar: hover-иконки (pin/star/bell) занимают 120px в DOM постоянно
**Статус:** `[ ]`

**Проблема:** Три кнопки с `opacity-0` постоянно занимают 3×w-10 = 120px справа, обрезая имя и превью сообщения. `pointer-events-none` добавлен (фикс C-клика), но layout не изменился.

**Где:** `client/src/components/chat/chat-sidebar.tsx` — row actions section.

**План:**
1. Заменить `opacity-0 group-hover:opacity-100` на `w-0 overflow-hidden group-hover:w-10` (layout collapse при hidden).
2. Или: `position: absolute; right: 0` + `opacity-0 group-hover:opacity-100` — тогда кнопки не занимают layout-пространство.
3. Вариант 2 проще, не ломает существующие Tailwind классы.
4. Проверить в обоих шеллах.

---

### C2 🟡 DECRYPT_FAIL: пользователь не понимает что произошло
**Статус:** `[ ]`

**Проблема:** При ротации ECDH ключа (пересоздание vault / другое устройство) старые сообщения показывают `[DECRYPT_FAIL]` без объяснения. Сообщения необратимо недоступны.

**Где:** `client/src/components/chat/chat-terminal.tsx` — рендер сообщений.

**План:**
1. Добавить специальный bubble-компонент для `[DECRYPT_FAIL]` — не просто текст, а иконка замка + "Сообщение зашифровано другим ключом. Расшифровка невозможна — ключ был изменён."
2. Не кешировать `[DECRYPT_FAIL]` в IndexedDB (уже есть в `use-load-chat-messages`).
3. Опционально: кнопка "Подробнее" → объяснение что такое ротация ключа.

---

### C3 🟡 Mobile: touch-pass по всем модалкам
**Статус:** `[ ]`

**Проблема:** Drawer, composer, search overlay, vault modal, identity modal — не проходили живой touch-тест на телефоне. Из AGENT_PROGRESS: нужен один touch-pass.

**Где:** `client/src/components/chat/chat-app.tsx`, все modal-компоненты.

**План:**
1. Открыть на реальном мобильном (или Chrome DevTools touch emulation).
2. Проверить: drawer open/close, composer (emoji, attach, send), search overlay, vault pin-input, identity modal.
3. Исправить найденные проблемы с tap targets (< 44px), scroll-lock, keyboard push.

---

## D — Runtime E2E валидация

### D1 🟠 Invite flow: group_e2e с передачей ключа
**Статус:** `[x]` Playwright тест добавлен 2026-04-22 (7b3a9da): tests/e2e-runtime.spec.ts

Тест-план:
1. Пользователь A создаёт `group_e2e` → копирует invite link.
2. Пользователь B открывает `join/[code]` → вступает.
3. A видит нового участника → (после A1) передаёт `encrypted_group_key`.
4. B может отправить сообщение → A получает и расшифровывает.
5. A отправляет → B расшифровывает.

---

### D2 🟠 Direct fanout: 2 реальных устройства/аккаунта
**Статус:** `[x]` Playwright тест добавлен 2026-04-22 (7b3a9da): tests/e2e-runtime.spec.ts

Тест-план:
1. Аккаунт A на устройстве 1, аккаунт B на устройстве 2.
2. A → B: сообщение доставлено и расшифровано.
3. B → A: то же самое.
4. `[DECRYPT_FAIL]` не появляется.
5. После logout/login A снова может расшифровать (vault unlock обновляет ECDH).

---

### D3 🟡 Saved Messages: создание, reload, multi-device
**Статус:** `[ ]`

Тест-план:
1. Открыть Saved Messages → отправить сообщение → перезагрузить → сообщение на месте.
2. Войти с устройства 2 → Saved Messages → сообщения не видны (ожидаемо: разные ECDH ключи).
3. Если multi-device sync нужен → планируется в рамках A4 (DR).

---

### D4 🟡 DR runtime: protocol_version=2 end-to-end
**Статус:** `[ ]` (зависит от A4)

Тест-план:
1. Включить `NEXT_PUBLIC_DR_ENABLED=1` (или убрать флаг после A4).
2. Два аккаунта → первое сообщение → network tab → `protocol_version: 2`, `dr_header` не null.
3. Перезагрузить страницу → переключиться на другой чат → вернуться → сообщения расшифрованы.
4. Out-of-order доставка (задержать WS) → сообщения всё равно расшифрованы.

---

### D5 🟡 TURN / coturn: runtime проверка
**Статус:** `[ ]`

Тест-план:
1. `GET /api/ice-servers` → HMAC-credentials в ответе.
2. Звонок через TURN (симулировать блок UDP → TURN forced).
3. `turns://` (TLS) работает через порт 5349.
4. При недоступности coturn → fallback на STUN (уже реализован в `ice-servers.ts`).

---

## E — Tech debt / мелкие вещи

### E1 🟢 Vault upgrade: проверить auto-upgrade v1-v3 → v4
**Статус:** `[x]` верифицировано 2026-04-22: `vault-modal.tsx:169-173` — `if (blob.version < CURRENT_VAULT_VERSION) upgradeVaultBlob(blob, pin).then(persist)` — вызывается при каждом unlock автоматически.

---

### E2 🟢 Device revoke: cleanup в message_deliveries
**Статус:** `[x]` закрыто 2026-04-22: `server/src/routes/users.ts` — 3 revoke-хендлера: single device, single session, bulk sessions — каждый теперь удаляет `message_deliveries WHERE device_id = revokedId`.

---

### E3 🟢 Rate limits: аудит на auth routes
**Статус:** `[x]` закрыто 2026-04-22: `/auth/challenge`+`/verify` — scoped 5/15min; `POST /keys/identity` 10/h, `POST /keys/signed-prekey` 20/h, `POST /keys/one-time` 5/h добавлены. Глобальный лимит 100/min применяется ко всему.

---

### E4 🟢 Lint / typecheck CI: строгий режим для новых файлов
**Статус:** `[x]` закрыто 2026-04-22: исправлены все 27 существующих violations (identity-modal, chat-app, explore-modal, user-avatar) → 0 violations. `continue-on-error: true` удалён из `prod-checks.yml` — теперь hard gate.

---

## F — UI/UX mass improvement (из аудита скринов 2026-04-22)

> Два шелла (MD3 + Cyberpunk/Terminal) — всё тестируется в обоих.

### F1 🔴 Sidebar row actions: убрать из layout → контекстное меню
**Статус:** `[x]` закрыто 2026-04-22 (коммит dd31788)

**Проблема:** Pin/star/bell иконки занимают ~120px **всегда** в DOM (opacity-0, но width сохранён). Имя чата и превью обрезаются. На скрине 1.jpg и photo_...-47.jpg видно явно.

**Решение:** Удалить inline-кнопки. Добавить контекстное меню по правому клику (desktop) / long-press (mobile) — паттерн Telegram. Меню: Pin / Unpin, Mute / Unmute, Mark as read, Archive, Delete.

**Файлы:** `client/src/components/chat/chat-sidebar.tsx`

**План:**
1. Удалить `<button>` pin/star/bell из JSX строки чата целиком.
2. Добавить `onContextMenu` handler на строку чата → открывает `<ChatRowContextMenu>`.
3. Компонент `chat-row-context-menu.tsx` — floating menu, `position:fixed`, keyboard-accessible.
4. Действия: Pin, Mute, Mark as read, Delete — вызывают те же API что были на кнопках.
5. Mobile: `onTouchStart` + таймер 500ms → открыть то же меню.
6. Оба шелла: Terminal style (border + monospace) / MD3 style (rounded + elevation).

---

### F2 🔴 DECRYPT_FAIL UX: убрать красный цвет, добавить понятный контекст
**Статус:** `[x]` закрыто 2026-04-22 (коммит dd31788)

**Проблема:** `[DECRYPT_FAIL]` отображается ярко-красным в пузырях сообщений и в превью чатлиста. Выглядит как критическая ошибка. Пользователь не понимает что произошло.

**Скрины:** photo_2026-04-22_11-24-48.jpg — весь чат в красных `[DECRYPT_FAIL]`.

**Решение:**
1. В пузыре сообщения: замок-иконка `🔒` + "Сообщение зашифровано другим ключом" — серый курсив, не красный.
2. В превью чатлиста: вместо `[DECRYPT_FAIL]` → `🔒 сообщение недоступно` серым.
3. При hover/tap на таком пузыре — tooltip: "Расшифровка невозможна: ключ изменился после создания vault."

**Файлы:** `client/src/components/chat/chat-terminal.tsx` (bubble render), `client/src/components/chat/chat-sidebar.tsx` (preview text)

---

### F3 🟠 Sidebar bottom: убрать хаос кнопок
**Статус:** `[x]` закрыто 2026-04-22 (7b3a9da): New Group/Channel/My Link → FAB "+" dropdown, Explore добавлен

**Проблема (MD3-скрин):** Снизу сайдбара нагромождено:
- "Удалить историю" — красная кнопка, слишком агрессивная
- "Warden" — непонятное название
- "Открыть диалог" + input
- "Новая группа" / "Новый канал"
- "Моя ссылка"

Всё это видно одновременно, нет иерархии.

**Решение:**
1. "Удалить историю" → убрать из sidebar, переместить в контекстное меню чата (F1).
2. "Warden" → переименовать или убрать (уточнить назначение).
3. Composer area: кнопки действий (Новая группа, Новый канал) → под single FAB "+" с dropdown.
4. "Моя ссылка" → в профиль/настройки, не в sidebar.
5. Результат: нижняя часть сайдбара = только input "Никнейм или ID" + кнопка "+" для новых чатов.

**Файлы:** `client/src/components/chat/chat-sidebar.tsx`

---

### F4 🟠 Message hover actions: позиционирование и состав
**Статус:** `[x]` закрыто 2026-04-22 (7b3a9da): absolute -top-8 над пузырём вместо flex-row сбоку

**Проблема:** Hover-кнопки на сообщении (ответ / forward / ...) появляются в разных местах в разных шеллах, иногда перекрывают текст.

**Решение:**
1. Всегда показывать над пузырём (не сбоку), fade-in при hover.
2. Состав: Reply, React (emoji), Forward, Delete — иконки без текста, tooltip при hover.
3. Для своих сообщений дополнительно: Edit (если < 48ч).
4. Оба шелла: унифицированное поведение, только стиль разный.

**Файлы:** `client/src/components/chat/chat-terminal.tsx`

---

### F5 🟡 Sidebar resize / минимальная ширина
**Статус:** `[x]` закрыто 2026-04-22: drag handle между sidebar и main, диапазон 240-480px, localStorage persistence, CSS var `--p13-sb-w` контролирует ширину.

---

### F6 🟡 Аватары в сайдбаре: placeholder при пустом
**Статус:** `[x]` закрыто 2026-04-22: `user-avatar.tsx` — `hashToHue(username)` даёт детерминированный hue, fallback = `linear-gradient(135deg, hsl(hue,55%,30%), hsl(hue+45,50%,22%))` + инициалы.

---

### F7 🟡 Unread badge в sidebar
**Статус:** `[~]` верифицировано 2026-04-22: логика badge в sidebar корректна (unreadByChat → badge). Известное ограничение: счётчик не персистируется — сбрасывается при перезагрузке страницы (только in-memory Zustand store). Исторические unread с сервера не загружаются. Критической регрессии нет.

---

### F8 🟡 Composer: высота textarea auto-grow
**Статус:** `[x]` закрыто 2026-04-22: `chat-input.tsx` max-h изменён с 96px (4 строки) → 120px (5 строк) в 3 местах.

---

## Зависимости между задачами

```
A1 (group E2E key) ──────────────────────────────── D1 (invite e2e test)
A4 (DR enabled) ──┬──────────────────────────────── D4 (DR runtime test)
                  └── A3 (Call E2EE) ─── B4 (LiveKit) ─── A3
B4 (LiveKit) ───────────────────────────────────────── A3 (SFU E2EE)
A2 (trust store SHA-256) ─── B7 (safety numbers UI)
```

---

## История обновлений

| Дата | Что изменилось |
|------|----------------|
| 2026-04-22 | Создан файл — первичный аудит всех незакрытых задач |
| 2026-04-22 | **Блок 1 закрыт** — A1, A2, A4, B7: DR always-on, SHA-256 trust store, group key delivery on join, safety numbers UI (коммит 69c3a1c) |
| 2026-04-22 | **F1, F2 закрыты** — sidebar context menu + DECRYPT_FAIL UX (коммит dd31788) |
| 2026-04-22 | **ALL HIGH закрыты** — F3+F4 UI, B1 enforcement+discovery, B2, D1+D2 тесты; B3+B4+B5 верифицированы как уже реализованные (коммит 7b3a9da) |
| 2026-04-22 | **MEDIUM+LOW закрыты** — F5 sidebar resize, F6 avatar gradient, F8 textarea auto-grow; B1 channel type fix; B6/E1 верифицированы; E2 message_deliveries cleanup, E3 rate limits keys, E4 strict CI (0 violations); F7 задокументировано как known limitation |
