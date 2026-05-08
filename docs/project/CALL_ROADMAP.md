# OneToThree — Call System Roadmap
**Дата аудита:** 2026-05-08  
**Охват:** 1:1 P2P + Group Mesh + LiveKit SFU + TURN / signaling layer

---

## 1. Текущая архитектура

```
┌─────────────────────────────────────────────────────────┐
│                   CLIENT                                │
│                                                         │
│  use-webrtc.ts          group-call-manager.ts           │
│  (1:1 P2P calls)        (group mesh / origin-safe)      │
│        │                        │                       │
│        └──────────┬─────────────┘                       │
│                   │                                     │
│          livekit-call-manager.ts                        │
│          (SFU path, tried first for groups)             │
└──────────────────────┬──────────────────────────────────┘
                       │  WebSocket  (call_invite / webrtc_signal /
                       │             group_call:offer / :answer / :ice)
┌──────────────────────▼──────────────────────────────────┐
│                   SERVER                                │
│                                                         │
│  routes/ws.ts           routes/call.ts                  │
│  (signaling relay)      (LiveKit token, E2EE key)       │
│                                                         │
│  routes/webrtc.ts       ws/group-call-rooms.ts          │
│  (ICE/TURN config)      (in-memory room state)          │
│                                                         │
│  lib/cloudflare-turn.ts  lib/call-media-mode.ts         │
│  lib/call-media-persist.ts                              │
└─────────────────────────────────────────────────────────┘

Transport matrix:
  origin_safe  → WS audio relay (ECDH-encrypted PCM frames over app socket)
  self_hosted  → TURN/coturn (HMAC-SHA1 ephemeral creds) + LiveKit fallback
  cloudflare   → Cloudflare Calls TURN (10-min TTL credentials)
```

---

## 2. Что реализовано (работает)

| Компонент | Файл(ы) | Статус |
|-----------|---------|--------|
| 1:1 звонки (голос + видео) | `use-webrtc.ts` | ✅ |
| ICE restart on disconnect (3 попытки) | `use-webrtc.ts:368-392` | ✅ |
| 30-секундный таймаут соединения | `use-webrtc.ts:985` | ✅ |
| Входящий звонок — модал + звонок | `incoming-call-modal.tsx`, `call-ringtones.ts` | ✅ |
| Минимизация звонка (mini-player) | `call-mini-player.tsx`, `callStore.ts` | ✅ |
| Расшаривание экрана (1:1, только replaceTrack) | `use-webrtc.ts` | ✅ |
| Групповые звонки — полный mesh | `group-call-manager.ts` | ✅ |
| Групповые звонки — LiveKit SFU | `livekit-call-manager.ts` | ✅ |
| LiveKit E2EE (ExternalE2EEKeyProvider) | `livekit-call-manager.ts`, `call.ts` | ✅ |
| TURN: coturn (HMAC-SHA1 ephemeral) | `webrtc.ts`, `cloudflare-turn.ts` | ✅ |
| TURN: Cloudflare Calls | `cloudflare-turn.ts` | ✅ |
| WS audio relay (origin-safe mode) | `call-audio-relay.ts` | ✅ |
| Блокировка звонков (block-check) | `ws.ts:453` | ✅ |
| Push-уведомление о звонке | `push.ts` (тип `incoming_call`) | ⚠️ не триггерится |
| Quality/bitrate выбор пользователем | `callStore.ts`, overlay | ✅ |
| P2P/relay индикатор на тайле | `active-call-overlay.tsx` | ✅ |

---

## 3. Дыры и проблемы (по критичности)

### 🔴 P0 — Ломает UX прямо сейчас

#### C-1: Push-уведомление о входящем звонке не отправляется
**Файл:** `server/src/routes/ws.ts:462`  
**Проблема:** При `call_invite` сервер рассылает WS-событие только онлайн-соединениям — `sendPushToUser` не вызывается. Если пользователь в фоне (телефон заблокирован), звонок молча пропадает.  
**Решение:** В обработчике `call_invite` вызвать `sendPushToUser` для каждого `otherIds` с `{ type: 'incoming_call', title: '...' }`.

#### C-2: Нет таймаута звонка на сервере + нет "пропущенного звонка" в чате
**Проблема:** Клиент-отправитель играет гудок бесконечно. Если получатель не ответил, никакого следа в истории нет.  
**Решение:**
1. `call_invite` → сервер сохраняет в Redis `call:pending:{chatId}:{callerId}` с TTL 60 сек.
2. При `call_leave` (или по истечении TTL) — сервер вставляет системное сообщение `{ type: 'missed_call' }` в таблицу messages.
3. Клиент рендерит пузырь «Пропущенный звонок» в истории.

#### C-3: Нет reject-события
**Проблема:** Когда пользователь нажимает "Отклонить" в модале, отправляется `call_leave`. Звонящий не знает — пропустили или отклонили.  
**Решение:** Добавить WS-тип `call_reject` (схема идентична `call_leave`). Звонящий видит «Вызов отклонён» вместо тишины.

---

### 🟠 P1 — Важные, не блокирующие

#### C-4: Multi-device — оба устройства звонят, отмена не синхронизирована
**Проблема:** `call_invite` рассылается всем онлайн-соединениям пользователя. Если принять на одном устройстве — на втором продолжает звонить.  
**Решение:** При приёме звонка отправлять `call_accept` → сервер рассылает всем устройствам получателя `call_cancel_on_other_devices`. Клиент закрывает модал.

#### C-5: Групповой call room state — in-memory, сбрасывается на рестарт
**Файл:** `server/src/ws/group-call-rooms.ts`  
**Проблема:** `const rooms = new Map<...>()` — всё в памяти. После деплоя участники "теряются" из комнаты, но LiveKit не знает об этом.  
**Решение:** Вынести room state в Redis (HSET/HGET). Ключ `group-call:room:{roomId}`, TTL = 8h. При reconnect — LiveKit событие `ParticipantConnected` является source-of-truth для SFU-режима.

#### C-6: 1:1 P2P медиа не E2EE в TURN-режиме
**Проблема:** В `self_hosted` / `cloudflare` режиме медиастримы идут через TURN-сервер. DTLS зашифровывает transport layer, но TURN relay видит зашифрованный SRTP — что нормально. Однако нет дополнительного application-level E2EE поверх SRTP (в отличие от SFU E2EE через Insertable Streams).  
**Решение (опционально):** Реализовать Insertable Streams + shared ECDH key для 1:1 (аналогично LiveKit E2EE). Scope: только для `origin_safe` режима через WS relay это уже сделано (`encryptBytes/decryptBytes`). Для прямого P2P — опционально, задача непростая.

#### C-7: Нет истории звонков в БД
**Проблема:** Нет таблицы `call_sessions` — нельзя показать список звонков, длительность, участников.  
**Решение:**
```sql
CREATE TABLE call_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     UUID NOT NULL REFERENCES chats(id),
  initiated_by UUID NOT NULL REFERENCES users(id),
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  duration_secs INTEGER,
  call_type   TEXT NOT NULL DEFAULT 'audio', -- 'audio' | 'video' | 'group'
  participant_ids UUID[] NOT NULL DEFAULT '{}',
  end_reason  TEXT  -- 'completed' | 'missed' | 'rejected' | 'timeout'
);
```
Заполнять при `call_leave` / пропущенном TTL.

---

### 🟡 P2 — Улучшения качества

#### C-8: Расшаривание экрана в 1:1 — нет индикатора у собеседника
**Проблема:** При screen share через `replaceTrack` у peer нет никакого визуального сигнала что идёт демонстрация (в отличие от группового звонка где `isScreenSharing` пробрасывается).  
**Решение:** Добавить WS-сигнал `{ type: 'webrtc_signal', signalData: { kind: 'screen_share_start' | 'screen_share_stop' } }` и отображать в overlay.

#### C-9: Нет UI отклонения звонка с причиной
**Текущее состояние:** Кнопка reject отправляет `call_leave`. Нет возможности выбрать "занят" / "не беспокоить".  
**Решение:** Добавить `busy` режим — при включённом DND автоматически отправлять `call_reject` с `reason: 'busy'`.

#### C-10: Нет call transfer / hold
Ни hold-музыки, ни передачи звонка. Низкий приоритет для мессенджера, но нужно для enterprise-применения.

#### C-11: Дубляж TURN-нормализации в трёх местах
**Файлы:** `use-webrtc.ts`, `group-call-manager.ts`, `webrtc.ts` (сервер) — каждый реализует `normalizeTurnUrl` самостоятельно.  
**Решение:** Вынести в `client/src/lib/ice-servers.ts` (уже существует как частичное решение) и импортировать оттуда.

---

## 4. Дорожная карта

### Sprint C1 — Критичный UX (1–2 дня)

| ID | Задача | Файл(ы) | Сложность |
|----|--------|---------|-----------|
| C-1 | Push при входящем звонке | `server/src/routes/ws.ts` | S |
| C-3 | WS-тип `call_reject` | `ws.ts`, `socket.ts`, `use-webrtc.ts`, `incoming-call-modal.tsx` | S |
| C-2a | Redis TTL для pending call | `ws.ts` | M |
| C-2b | Системное сообщение "пропущенный звонок" | `ws.ts`, `chat-message-persist.ts`, клиент-рендер | M |

### Sprint C2 — Надёжность (2–3 дня)

| ID | Задача | Файл(ы) | Сложность |
|----|--------|---------|-----------|
| C-5 | Group call room state → Redis | `group-call-rooms.ts` | M |
| C-4 | Multi-device call cancel on accept | `ws.ts`, `use-webrtc.ts` | M |
| C-7 | Таблица `call_sessions` + миграция | `schema.ts`, `ws.ts` | M |
| C-8 | Screen share индикатор в 1:1 | `use-webrtc.ts`, `active-call-overlay.tsx` | S |

### Sprint C3 — Качество (1 день)

| ID | Задача | Файл(ы) | Сложность |
|----|--------|---------|-----------|
| C-11 | Дедупликация TURN нормализации | `ice-servers.ts` + импорты | S |
| C-9 | DND / busy rejection | `callStore.ts`, `ws.ts` | S |
| — | Smoke-тест звонков в обоих шеллах | `active-call-overlay.tsx`, `group-call-screen.tsx` | S |

### Sprint C4 — E2EE + аналитика (опционально)

| ID | Задача | Файл(ы) | Сложность |
|----|--------|---------|-----------|
| C-6 | Insertable Streams E2EE для 1:1 P2P | `use-webrtc.ts`, `call.ts` | L |
| C-10 | Call hold / transfer | весь стек | XL |
| — | Call quality dashboard (RTT, bitrate, PLR) | новый admin route | L |

---

## 5. Ключевые инварианты (не трогать)

- **Нет STUN-only fallback в `self_hosted`** — TURN обязателен, hard fail на 503. `webrtc.ts:TURN_NOT_CONFIGURED`.
- **ICE credentials не хранятся в клиентском бандле** — всегда через `/api/ice-servers`.
- **WS relay для `origin_safe`** — серверный IP не должен утекать через SDP offer. `call-audio-relay.ts` + `encryptBytes/decryptBytes` — not negotiable.
- **LiveKit E2EE key** — HMAC-SHA256 per-session через Redis, не per-deployment константа.
- **SDP relay остаётся opaque** — `webrtc_signal` не парсится сервером (комментарий в `ws.ts:431`).
