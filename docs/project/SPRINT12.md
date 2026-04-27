# SPRINT 12 — Audit, UI/UX Fixes, Platform Quality (2026-04-27)

> Статус: `[ ]` — не начато | `[~]` — в процессе | `[x]` — выполнено | `[!]` — заблокировано

---

## Задачи по приоритету

### P0 — Runtime/Critical

| # | Задача | Файлы | Статус |
|---|--------|-------|--------|
| 12.01 | Scroll to first unread при открытии диалога | `chat-terminal.tsx` | [x] commit 24c5645 |
| 12.02 | Unread badge — синхронизация с реальным состоянием | `unreadStore.ts`, `chats.ts` | [x] commit f627a4f |
| 12.03 | GIF proxy endpoint на сервере (CORS + fallback) | `server/src/routes/gif.ts` | [x] уже реализован |
| 12.04 | Sticker preview — диагностика loadStickerDisplayUrl | — | [!] нет стикер-паков (нужен TELEGRAM_BOT_TOKEN) |
| 12.05 | APK login — QR linking починен (allowDeviceLinking=true) | `schema.ts`, migration 0042 | [x] commit 37670b7 |
| 12.06 | QR — allowDeviceLinking был false по умолчанию | `schema.ts`, migration 0042 | [x] commit 37670b7 |

### P1 — UI/UX

| # | Задача | Файлы | Статус |
|---|--------|-------|--------|
| 12.07 | Retro тема — полный рестайл под Win98/XP/ICQ/Winamp | `globals.css` | [x] commit 24c5645 |
| 12.08 | Mobile — back button + auto-open sidebar | `chat-app.tsx` | [x] commit 55c89a7 |
| 12.09 | Mobile — composer input height, keyboard jump | `chat-input.tsx`, CSS | [x] commit 8ed76ea |
| 12.10 | MD3 shell — message bubbles polish (both shells) | `globals.css` | [x] commit 8ed76ea |

### P2 — Features / Audit

| # | Задача | Файлы | Статус |
|---|--------|-------|--------|
| 12.11 | Calls SFU — LiveKit client wiring (3+ участника) | `livekit-call-manager.ts`, `group-call-manager.ts` | [x] commit d09ba40 |
| 12.12 | Security audit: DR bootstrap, TOFU, vault v4 upgrade | `vault-modal.tsx`, `trust-store.ts` | [x] commit a62f656 |
| 12.13 | Full typecheck + lint + tests green | — | [~] typecheck clean; tests need DB |

---

## Лог работы (Sprint 12)

| Дата | Что сделано |
|------|-------------|
| 2026-04-27 | Sprint 12 план создан; анализ 11 открытых проблем |
| 2026-04-28 | 12.01 scroll to unread; 12.02 unread badge; 12.05/06 QR/device linking; 12.07 retro theme; 12.08 mobile back button — предыдущая сессия |
| 2026-04-28 | 12.09 keyboard UX (enterKeyHint, scrollIntoView); 12.10 shell-aware bubble meta colors; 12.11 LiveKit SFU wiring; 12.12 vault upgrade race fix + security audit |

---

## Диагностика (первоначальная)

### 12.01 Scroll to first unread
**Проблема**: `useLayoutEffect([activeChatId])` в `chat-terminal.tsx:437` всегда скроллит в `scrollHeight` (самый низ). 
`firstUnreadAnchorId` вычисляется в `useEffect` ПОСЛЕ рендера, но никто не скроллит к нему.
**Фикс**: добавить `didScrollToUnreadRef`; в `useEffect([firstUnreadAnchorId])` при первом вычислении — `scrollIntoView` на элемент с `id={firstUnreadAnchorId}`.

### 12.02 Unread badge
**Проблема**: счётчик хранится в localStorage (Zustand persist). Растёт при WS-событиях (`trackInboundUnread`), сбрасывается через `markChatRead`. 
Проблема: при перезапуске приложения счётчики могут не совпадать с реальным состоянием. Также — `markChatRead` не всегда вызывается корректно при открытии чата.
**Фикс**: гарантировать вызов `markChatRead(chatId)` при открытии чата (`activeChatId` change + when user scrolls to bottom).

### 12.03 GIF proxy
**Проблема**: `buildGifProxyUrl` формирует URL `/api/gif/fetch?url=...`, но этот эндпоинт может отсутствовать на сервере или не работать.
**Фикс**: добавить/проверить `GET /api/gif/fetch` на сервере (проксировать Giphy-URL через сервер, избегая CSP/CORS).

### 12.04 Sticker preview
**Проблема**: `loadStickerDisplayUrl` вызывает `GET /api/stickers/asset-url?key=...`. Если стикеры не загружены через Telegram import — таблица пустая, URL не резолвится.
**Фикс**: убедиться что sticker import flow работает; добавить демо-паки; проверить endpoint.

### 12.05 APK login
**Проблема**: `NEXT_PUBLIC_API_URL` должен быть `https://api.onetothree.ru` в `client/.env.production`. В APK (Capacitor) используется статический export (`out/`), поэтому NEXT_PUBLIC переменные должны быть захардкожены. При авторизации cookie `fm_session` должна ставиться на `api.onetothree.ru`, а `warmNativeSessionCookies` должна её захватить.
**Фикс**: проверить `client/.env.production` + `capacitor.config.json` server.url; убедиться что `CapacitorHttp: enabled: true` + `CapacitorCookies: enabled: true`.

### 12.06 QR
**Проблема**: QR сканер в `login-qr-device-panel.tsx` работает только на устройстве с камерой. QR handoff flow: сканируем QR → получаем link_token → GET /auth/qr?link_token=... → `postQrLogin(token)` → vault handoff.
Может ломаться если: vault blob не синхронизирован на сервере; `postQrLogin` кидает ошибку до vault-чтения.

### 12.07 Retro тема (Win98/XP/ICQ)
**Нужно**: классическая Windows 98 палитра — серый chrome #c0c0c0, синий заголовок #000080, Tahoma/MS Sans Serif, raised/sunken bevel-borders, плоские квадратные кнопки с 3D-эффектом, белые input поля, синие selected строки.

### 12.11 Calls SFU
**Статус**: LiveKit токены на сервере генерируются (`POST /api/calls/livekit-token`?). Клиент `use-group-call.ts` — нужно проверить, подключается ли LiveKit SDK к серверу.
