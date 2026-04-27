# OneToThree — Security & Quality Audit
**Дата:** 2026-04-22  
**Охват:** Криптография, серверная безопасность, QR/TOTP/Auth, UI/UX, баги/error handling

---

## 🔴 CRITICAL (5 проблем)

### C1. TOTP secret хранится в открытом виде в БД
- **Файл:** `server/src/db/schema.ts:61` — `totpSecret: text('totp_secret')`
- **Риск:** Утечка дампа БД = мгновенная компрометация всех 2FA секретов без брутфорса
- **Фикс:** AES-256-GCM с ключом из Docker secrets; encrypt при записи, decrypt только при verify/setup

### C2. Push handler: `event.data.text()` не awaited
- **Файл:** `client/public/push-handler.js:42`
- **Риск:** `payload.body = "[object Promise]"` — уведомление показывает мусор вместо текста. Критическая регрессия UX.
- **Фикс:** `const text = await event.data.text(); const payload = JSON.parse(text)`

### C3. `window.addEventListener('online', ...)` никогда не снимается
- **Файл:** `client/src/lib/api/socket.ts:225`
- **Риск:** Каждый reconnect добавляет listener → multiple outbox flushes, memory leak
- **Фикс:** Хранить ref на handler, снимать в cleanup функции subscribe()

### C4. Fan-out `Promise.allSettled()` молча отбрасывает failed slots
- **Файл:** `client/src/lib/fanout-crypto.ts:76`
- **Риск:** Если шифрование для устройства упало — получатель не расшифрует, не получит ошибки. Silent delivery failure.
- **Фикс:** Логировать rejected + возвращать `{ slots, failedDeviceIds }` наверх; клиент показывает предупреждение

### C5. Vault blob: version/argon2 params не покрыты AES-GCM AAD
- **Файл:** `client/src/lib/vault.ts` (функция `wrapPrivateJwkWithPin`)
- **Риск:** Атакующий через XSS меняет `version: 4` → `version: 1`, `argon2.t: 3` → PBKDF2 210k итераций (~280× быстрее). Downgrade + offline brute force.
- **Фикс:** Передать `JSON.stringify({version, salt, argon2})` как AAD в `crypto.subtle.encrypt()`

---

## 🟠 HIGH (10 проблем)

### H1. Call E2EE key детерминистичен, нет forward secrecy
- **Файл:** `server/src/routes/call.ts` (функция `trySfuFallback` + token endpoint)
- **Проблема:** `call_e2ee_key = HMAC(apiSecret, "e2ee:" + roomId)` — постоянный ключ на весь lifetime комнаты. Бывший участник навсегда имеет ключ.
- **Фикс:** Добавить `callSessionId = crypto.randomUUID()` при инициации звонка → `HMAC(apiSecret, "e2ee:" + roomId + ":" + callSessionId)`. Хранить `callSessionId` в Redis с TTL. Рассылать через WS при ротации (новый участник — новый ключ).

### H2. TOTP step-up не покрывает `/2fa/disable` и `/2fa/setup`
- **Файлы:** `server/src/routes/auth.ts:291` (`/2fa/setup`), `server/src/routes/auth.ts:327` (`/2fa/disable`)
- **Риск:** Сессионного cookie достаточно для отключения 2FA → account takeover
- **Фикс:** Добавить `await requireTotpStepUp(request, reply, userId)` в оба роута

### H3. JWT denylist не проверяется во всех запросах
- **Файл:** `server/src/lib/auth-user.ts:48`
- **Проблема:** `isJtiDenied()` вызывается только в опциональном `verifySessionJwt()`. Некоторые роуты используют `getAuthUser()` напрямую → отозванные JWT принимаются.
- **Фикс:** Сделать `verifySessionJwt()` обязательным шагом внутри `getAuthUser()`

### H4. `POST /api/messages/delivered` без проверки членства
- **Файл:** `server/src/routes/messages.ts:323`
- **Риск:** Любой аутентифицированный пользователь может отметить чужие сообщения как доставленные
- **Фикс:** JOIN `message_deliveries → messages → chat_members` с проверкой `userId`

### H5. SSRF: hostname не перепроверяется после редиректа
- **Файл:** `server/src/routes/link-preview.ts:54`
- **Риск:** Публичный URL может редиректить на `localhost`/`169.254.x.x` (metadata API) после первоначальной проверки
- **Фикс:** Вызывать `assertHostnameSafeForFetch()` на каждом шаге редиректа (перехватить в fetch options → `redirect: 'manual'` + loop)

### H6. Все fetch() без AbortController / таймаута
- **Файлы:** `client/src/lib/api/messages.ts` и все `client/src/lib/api/*.ts` (~79 вызовов)
- **Риск:** При мёртвом соединении запросы висят вечно, блокируя UI
- **Фикс:** Создать обёртку `fetchWithTimeout(url, opts, timeoutMs = 15_000)` с `AbortController`; заменить все вызовы

### H7. Outbox: одна ошибка останавливает очередь, нет exponential backoff
- **Файл:** `client/src/lib/outbox.ts:114-139`
- **Риск:** Временная сетевая ошибка = застрявшее сообщение навсегда
- **Фикс:** Per-message retry counter, exponential backoff (1s → 2s → 4s → max 60s), max 10 attempts → перемещать в dead-letter

### H8. `setInterval` health-check утекает при unmount
- **Файл:** `client/src/hooks/use-webrtc.ts:665`
- **Риск:** Interval чистится только при смене `userId`, не при unmount → accumulation при навигации
- **Фикс:** Сохранить ref, добавить в cleanup useEffect

### H9. Sidebar не виртуализирован
- **Файл:** `client/src/components/chat/chat-sidebar.tsx`
- **Риск:** 100+ чатов = DOM-bloat, заметный лаг на мобильных
- **Фикс:** `@tanstack/react-virtual` уже в deps → `useVirtualizer` для списка чатов

### H10. `devicechange` listener не снимается
- **Файл:** `client/src/components/settings-media-panel.tsx`
- **Фикс:** Хранить handler ref, снимать в `return () => md.removeEventListener('devicechange', handler)`

---

## 🟡 MEDIUM (12 проблем)

### M1. Incoming-call modal не поддерживает MD3 shell
- **Файл:** `client/src/components/call/incoming-call-modal.tsx:30-100`
- **Проблема:** Хардкод `border-neon-red`, `font-mono`, `bg-void` — пользователь MD3 видит terminal-стиль
- **Фикс:** Добавить `const isMd3 = useThemeStore(s => s.shellMode) === 'md3'` + MD3-ветку аналогично vault-modal

### M2. Хардкод строк в call UI (нарушение i18n)
- **Файлы:** `client/src/components/call/incoming-call-modal.tsx:44,62`, `active-call-overlay.tsx:378`
- **Строки:** `"SYS.ALERT // INBOUND_LINK"`, `"PAYLOAD_TYPE"`, `"OPTICS_OFFLINE"`
- **Фикс:** Перенести в `en.ts` / `ru.ts` под ключи `call.*`, использовать `useTranslation()`

### M3. Vault unlock без индикатора прогресса Argon2
- **Файл:** `client/src/components/chat/vault-modal.tsx:155-185`
- **Проблема:** Argon2id (t=3, 64MiB) = 3–5 сек на слабом устройстве. Кнопка замирает, пользователь жмёт повторно.
- **Фикс:** Показывать spinner + текст "Generating keys..." пока `busy = true`; кнопка disabled

### M4. Модалки без focus trap, ESC handler и scroll-lock
- **Файлы:** `vault-modal.tsx`, `incoming-call-modal.tsx`, `create-group-modal.tsx`, `identity-modal.tsx`
- **Фикс:** `useEffect` с `keydown` ESC, `focus-trap-react` или ручной tabindex loop; `document.body.style.overflow = 'hidden'` при открытии

### M5. TOTP step-up: TOTP replay guard не вызывается при `/login/2fa`
- **Файл:** `server/src/routes/auth.ts:399`
- **Проблема:** Вызывается только `verifyTotp()`, не `consumeTotpCode()` → код повторно используем в 30-сек окне
- **Фикс:** После `verifyTotp()` вызвать `consumeTotpCode(userId, code)`, при `false` — 401 TOTP_ALREADY_USED

### M6. Device revoke не атомарен
- **Файл:** `server/src/routes/users.ts:673`
- **Проблема:** Между `UPDATE devices SET revokedAt` и `DELETE FROM message_deliveries` есть окно ~мс
- **Фикс:** Обернуть в `await db.transaction(async tx => { ... })`

### M7. Push payload содержит message preview (title/body)
- **Файл:** `server/src/lib/push.ts:56-61`
- **Риск:** Push-сервисы Apple/Google видят plaintext содержимое сообщений
- **Фикс:** Отправлять только `{"action": "new_message", "chatId": "..."}` → клиент fetch'ит и расшифровывает

### M8. X3DH HKDF info не привязан к peer identity
- **Файл:** `client/src/lib/ratchet/x3dh.ts:69-88`
- **Проблема:** `info = "ForestMsg/x3dh/1"` без userId/identityKey peer'а → отклонение от Signal-референса
- **Фикс:** `info = "ForestMsg/x3dh/1" + sha256(peerUserId + peerIdentityKey)`

### M9. Message ordering без tie-breaker при одинаковом timestamp
- **Файл:** `client/src/store/chatStore.ts:23`
- **Фикс:** Добавить в `messages` таблицу поле `seq BIGSERIAL`, сортировать по `(created_at, seq)`

### M10. TOTP QR без manual entry fallback
- **Файл:** `client/src/components/settings-modal.tsx`
- **Риск:** A11y failure — слабовидящие не могут включить 2FA
- **Фикс:** `<input type="text" readOnly value={totpSecret} />` + кнопка Copy под QR

### M11. Presigned URL TTL = 1 час
- **Файл:** `server/src/lib/s3.ts:199`
- **Фикс:** Upload TTL → 600s, download TTL → 300s

### M12. TOFU trust-store DJB2 collision window при миграции
- **Файл:** `client/src/lib/trust-store.ts:36-72`
- **Проблема:** В момент auto-upgrade принимаются DJB2 (32-bit) checksums → коллизия за ~4 млрд итераций
- **Фикс:** Grace period 30 дней (via localStorage timestamp), затем отвергать legacy + требовать re-verify

---

## 🟢 LOW / INFO (8 проблем)

### L1. Hardcoded fallback `http://127.0.0.1:8080` в socket.ts
- **Файл:** `client/src/lib/api/socket.ts:41`
- **Фикс:** При отсутствии `NEXT_PUBLIC_WS_ORIGIN` бросать ошибку в build-time, не fallback на localhost

### L2. Empty states отсутствуют
- Sidebar без чатов, message list после поиска без результатов — нет placeholder UX
- **Фикс:** SVG-иллюстрация + текст в обоих shells

### L3. Skeleton loaders отсутствуют для message list
- **Фикс:** `MessageSkeleton` компонент, показывать пока `useMessages()` pending

### L4. Password strength indicator отсутствует в vault/login
- **Фикс:** Минимальная проверка: длина ≥ 12, наличие цифр/символов + zxcvbn score

### L5. Tap targets < 44px на мобильных
- Элементы `h-8`, `h-9` (`32px`, `36px`) в call controls и sidebar
- **Фикс:** `min-h-[44px] min-w-[44px]` для интерактивных элементов

### L6. Backup/recovery codes без UI для скачивания после TOTP setup
- **Файл:** `client/src/components/settings-modal.tsx:68`
- **Фикс:** Кнопка скачать `.txt` с recovery codes после enrollment

### L7. Argon2id params на OWASP baseline (не консервативно для E2EE)
- **Файл:** `client/src/lib/vault.ts:23-28` — t=3, m=64MiB
- **INFO:** Рассмотреть t=4, m=128MiB для будущей версии vault (v5)

### L8. 8× `@ts-ignore`/`no-explicit-any` в webauthn-vault.ts
- Осознанно из-за WebAuthn API несовместимостей — задокументировать причину в комментарии

---

## Приоритетный план реализации

### Sprint 0 — Критические исправления (≤ 3 дня)
| # | Задача | Файл |
|---|--------|------|
| C2 | `await event.data.text()` в push-handler | `client/public/push-handler.js:42` |
| C3 | Снять `window.addEventListener('online', ...)` | `client/src/lib/api/socket.ts:225` |
| C4 | Fan-out возвращать failed slots | `client/src/lib/fanout-crypto.ts:76` |
| H4 | `/messages/delivered` проверка членства | `server/src/routes/messages.ts:323` |

### Sprint 1 — Критическая безопасность (1 неделя)
| # | Задача | Файл |
|---|--------|------|
| C1 | Шифрование TOTP secrets at-rest | `server/src/db/schema.ts:61` |
| C5 | Vault AAD = version + argon2 params | `client/src/lib/vault.ts` |
| H1 | Call E2EE key ротация через callSessionId | `server/src/routes/call.ts` |
| H2 | Step-up TOTP на `/2fa/disable`, `/2fa/setup` | `server/src/routes/auth.ts:291,327` |
| H3 | JWT denylist в каждом запросе | `server/src/lib/auth-user.ts:48` |
| H5 | SSRF redirect re-validation | `server/src/routes/link-preview.ts:54` |
| M5 | `consumeTotpCode` при `/login/2fa` | `server/src/routes/auth.ts:399` |
| M7 | Push payload → только tickle | `server/src/lib/push.ts:56-61` |

### Sprint 2 — Надёжность (1 неделя)
| # | Задача | Файл |
|---|--------|------|
| H6 | `fetchWithTimeout` wrapper | `client/src/lib/api/*.ts` |
| H7 | Outbox: backoff + max retries | `client/src/lib/outbox.ts` |
| H8 | `setInterval` cleanup при unmount | `client/src/hooks/use-webrtc.ts:665` |
| H10 | `devicechange` listener cleanup | `settings-media-panel.tsx` |
| M6 | Device revoke в транзакции | `server/src/routes/users.ts:673` |
| H9 | Sidebar виртуализация | `chat-sidebar.tsx` |

### Sprint 3 — UX / полировка (1 неделя)
| # | Задача | Файл |
|---|--------|------|
| M1 | Incoming-call modal MD3 shell | `incoming-call-modal.tsx` |
| M2 | i18n для call strings | `incoming-call-modal.tsx`, `active-call-overlay.tsx` |
| M3 | Vault unlock прогресс Argon2 | `vault-modal.tsx` |
| M4 | Focus trap + ESC + scroll-lock во всех модалках | все modal компоненты |
| M10 | TOTP manual entry fallback | `settings-modal.tsx` |
| L2/L3 | Empty states + skeleton loaders | `chat-sidebar.tsx`, `chat-app.tsx` |
| L4 | Password strength indicator | `login-form.tsx` |

---

## Оценка

**Сильные стороны проекта:**
- E2EE архитектура корректна: fan-out per-device, DR v2 (X3DH + Double Ratchet), Argon2id vault, SHA-256 trust
- Rate limits, CORS, CSP настроены консервативно
- Drizzle + Zod везде — SQL injection маловероятен
- Docker secrets first pattern — правильно
- Auth без паролей (ECDSA challenge-response) — хороший выбор
- CI strict mode (0 violations), dual-shell coverage

**Ключевые риски (требуют Sprint 0-1):**
- TOTP secret plaintext → катастрофа при любой утечке БД
- Vault downgrade через AAD gap → offline brute force через XSS
- Call E2EE постоянный key → нивелирует весь смысл A3 для реальных threat model
- Push plaintext → утечка через Apple/Google servers

**Вывод:** Проект реализует правильную концепцию и большую часть крипто-архитектуры корректно. Критические баги — это точечные упущения (2 из 5 — буквально 1-строчные фиксы), не системные проблемы. После Sprint 0-1 проект выйдет на production-ready уровень безопасности.
