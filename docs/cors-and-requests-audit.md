# CORS, HTTP-запросы, сессия и MinIO — аудит и чеклисты

Этот документ — результат **статического** прохода по репозиторию (сверка клиента ↔ [`server/src/app.ts`](../server/src/app.ts) CORS ↔ маршруты Fastify ↔ MinIO CORS). Обновляйте таблицы при добавлении новых `fetch` или заголовков.

---

## 1. Клиент: HTTP-методы (`client/src`)

Все явные `method` в клиенте — подмножество списка в `app.ts`:  
`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`.

| Метод   | Файлы / назначение |
|--------|---------------------|
| `GET`  | [`auth.ts`](../client/src/lib/api/auth.ts) `/auth/me`, `/auth/ws-ticket`; [`vault.ts`](../client/src/lib/api/vault.ts) `/vault/fetch`; [`storage.ts`](../client/src/lib/api/storage.ts) download-url; [`chats.ts`](../client/src/lib/api/chats.ts) список/чат; [`users.ts`](../client/src/lib/api/users.ts) GET без явного method; [`use-load-chat-messages.ts`](../client/src/hooks/use-load-chat-messages.ts); [`proxy.ts`](../client/src/proxy.ts) (сервер Next, не браузерный CORS) |
| `POST` | auth (challenge/verify/2fa/logout), chats, messages read, users presence/lookup, storage upload-url, vault sync, push subscribe, settings 2fa, admin purge |
| `PATCH`| users/me, settings ecdh, chats member role, admin ban |
| `DELETE`| chats leave/delete, messages, devices, push unsubscribe |
| `PUT`  | [`chats.ts`](../client/src/lib/api/chats.ts) wrapped-key; [`use-send-media.ts`](../client/src/hooks/use-send-media.ts) **прямой PUT на presigned MinIO URL** (другой origin, см. §6) |

**Правило при изменениях:** новый метод → добавить в `methods` у `@fastify/cors` в [`server/src/app.ts`](../server/src/app.ts).

---

## 2. Клиент: заголовки к API ↔ `allowedHeaders`

Текущий список на сервере:  
`Content-Type`, `Authorization`, `X-Client-Device-Id`, `X-Device-Name`, `X-Nonce`, `X-Signature`.

| Заголовок | Где задаётся |
|-----------|----------------|
| `Content-Type` | почти все JSON `fetch`; avatar FormData задаёт браузер (multipart) |
| `Authorization` | зарезервировано CORS; клиент к своему API в основном использует cookie-сессию |
| `X-Client-Device-Id`, `X-Device-Name` | [`client-device.ts`](../client/src/lib/client-device.ts) → [`auth.ts`](../client/src/lib/api/auth.ts) `authDeviceHeaders()` на `/auth/verify` |
| `X-Nonce`, `X-Signature` | [`avatar.ts`](../client/src/lib/api/avatar.ts) через `sanitizeFetchHeaderRecord` |

Иных кастомных `X-*` к домену API в `client/src` не найдено.

**Правило при изменениях:** любой новый заголовок в браузерном `fetch` к API → добавить в `allowedHeaders` (или убрать заголовок).

---

## 3. `credentials: 'include'`

Используется во всех вызовах к своему API, где нужна сессия (auth, users, chats, messages, storage, vault, devices, admin, push, `chat-crypto`, настройки). Сервер: `credentials: true` в CORS — `Access-Control-Allow-Credentials` для доверенных origin из `CORS_ORIGIN`.

---

## 4. Сервер: префиксы маршрутов и методы

Префиксы из [`server/src/app.ts`](../server/src/app.ts): `/api/auth`, `/api/users`, `/api/chats`, `/api/messages`, `/api/storage`, `/api/push`, `/api/admin`, `/api/vault`, WebSocket `/api/ws`. Отдельно: **`GET /health`** (без `/api`).

### `/api/auth`

| Метод | Путь |
|-------|------|
| GET | `/ws-ticket`, `/me` |
| POST | `/logout`, `/2fa/setup`, `/2fa/verify-setup`, `/2fa/disable`, `/login/2fa` |
| POST | `/challenge`, `/verify` (внутри rate-limit scope в [`auth.ts`](../server/src/routes/auth.ts)) |

### `/api/users`

| Метод | Путь |
|-------|------|
| GET | `/me/avatar-challenge`, `/me/settings`, `/search`, `/me/devices` |
| POST | `/me/avatar`, `/presence`, `/lookup` |
| PATCH | `/me` |
| DELETE | `/me/devices/:deviceId` |

### `/api/chats`, `/api/messages`, `/api/storage`, `/api/push`, `/api/admin`, `/api/vault`

Соответствуют вызовам в [`chats.ts`](../client/src/lib/api/chats.ts), [`messages.ts`](../client/src/lib/api/messages.ts), [`storage.ts`](../client/src/lib/api/storage.ts), [`push-subscription.ts`](../client/src/lib/push-subscription.ts), [`admin.ts`](../client/src/lib/api/admin.ts), [`vault.ts`](../client/src/lib/api/vault.ts). Детальный grep: `app.(get|post|put|patch|delete)` в `server/src/routes/*.ts`.

### WebSocket

[`client/src/lib/api/socket.ts`](../client/src/lib/api/socket.ts) — не HTTP CORS; проверять TLS, `NEXT_PUBLIC_WS_ORIGIN`, тикет [`/api/auth/ws-ticket`](../client/src/lib/api/auth.ts).

---

## 5. Переменные окружения и сессия

Эталон ключей: [`env.prod.example`](../env.prod.example).

| Переменная | Роль |
|------------|------|
| `CORS_ORIGIN` | Явный origin фронта (в prod не `*`). Должен совпадать с URL приложения в браузере. |
| `COOKIE_DOMAIN` | Родительский домен (например `.onetothree.ru`), чтобы `fm_session` был на apex и `api.*`. |
| `NEXT_PUBLIC_API_URL` | Кросс-origin API; вместе с `COOKIE_DOMAIN` задаёт поведение кук. |
| `NEXT_PUBLIC_WS_ORIGIN` | База для WebSocket. |
| `TRUST_PROXY` | `1` за Caddy — корректный `request.ip` в логах/лимитах. |

Сессия: [`server/src/lib/session-cookie.ts`](../server/src/lib/session-cookie.ts) — `parseLastFmSessionValue` / `readFmSessionToken` (последний непустой `fm_session` при дубликатах в `Cookie`). Использование: [`server/src/lib/auth-user.ts`](../server/src/lib/auth-user.ts), [`server/src/routes/auth.ts`](../server/src/routes/auth.ts).

[`client/src/proxy.ts`](../client/src/proxy.ts) для SSR передаёт сырой `cookie` в `fetch` к API — это **серверный** запрос, не preflight браузера.

---

## 6. MinIO: PUT медиа

Клиент: [`use-send-media.ts`](../client/src/hooks/use-send-media.ts) — `PUT` на presigned URL с заголовком `Content-Type: <mime>`.

Сервер применяет CORS к бакету в [`server/src/lib/s3.ts`](../server/src/lib/s3.ts): `AllowedMethods` включает **PUT**, `AllowedHeaders: ['*']`. Если MinIO вернёт `501` на `PutBucketCors`, CORS бакета нужно задать вручную (консоль / `mc`), иначе браузерный PUT с другого origin упадёт независимо от Fastify.

---

## 7. Фаза 2 — ручной чеклист в браузере (разнесённые origin)

Выполнять на **реальном** деплое (фронт ≠ API), DevTools → Network → смотреть **failed OPTIONS** и консоль (`blocked by CORS policy`, `Preflight response`).

| Область | Действие | Проверить |
|---------|-----------|-----------|
| Auth | логин, 2FA, logout, открытие приложения | POST/GET, cookie, `X-Client-Device-Id` / `X-Device-Name` на verify |
| Профиль | настройки, смена discoverability / ключей | PATCH `/users/me` |
| Чаты | создать, инвайт, роль, выход, удалить чат | POST / PATCH / DELETE |
| Сообщения | история, удаление, read, вложение | GET / DELETE / POST |
| Storage | upload-url + **PUT на MinIO** | CORS второго origin |
| Push | subscribe / unsubscribe | POST / DELETE |
| Admin | список, ban, purge | GET / PATCH / POST |
| WS | чат в реальном времени | `wss`, 101 |

---

## 8. Автоматизация: preflight smoke

```bash
# С машины, где доступен API (и origin указан в CORS_ORIGIN на сервере):
set CORS_SMOKE_API_URL=https://api.example.com
set CORS_SMOKE_ORIGIN=https://app.example.com
npm run cors:smoke
```

Скрипт шлёт `OPTIONS` с типичными `Access-Control-Request-Method` / `Access-Control-Request-Headers` и проверяет ответы. Не заменяет ручной прогон MinIO PUT из браузера.

---

## 9. Правило для ревью

Любой новый браузерный `fetch` к API: обновить **методы/заголовки CORS** в [`server/src/app.ts`](../server/src/app.ts) либо явно задокументировать same-origin-only путь.
