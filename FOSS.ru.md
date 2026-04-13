# One To Three — Проект 13 (OneToThree)

**Лицензия: [GNU Affero General Public License v3.0 (AGPL-3.0-only)](./LICENSE)**

### Самохостируемый zero-trust мессенджер со сквозным шифрованием, открытым исходным кодом и без обязательного номера телефона

---

> **Философия:** сервер — это противник. Каждый байт, который он хранит, должен оставаться зашифрованным.
> Все ключи живут в браузере пользователя. Каждый звонок — peer-to-peer.
> Даже если сервер будет изъят, атакующий получит только зашифрованный шум и метаданные времени — и ничего больше.

**One To Three** — это самохостируемая платформа защищённой коммуникации со сквозным шифрованием, построенная по модели **zero-trust server**. В отличие от Signal (централизованный сервис с привязкой к номеру телефона), Telegram (серверное хранение и не везде обязательное E2EE) и Matrix (гибкий, но более сложный в эксплуатации), One To Three предлагает следующий подход:[cite:1]

|  | One To Three | Signal | Telegram | Matrix |
|---|---|---|---|---|
| Самохостинг | **Да** — сервер принадлежит вам | Нет | Нет | Да (но сложно) |
| Нужен номер телефона | **Нет** — только username | Да | Да | Нет |
| E2EE по умолчанию | **Во всех чатах** | Во всех чатах | Только в secret chats | Только в отдельных сценариях |
| Сервер видит содержимое | **Никогда** | Нет | В обычных чатах — да | Зависит от конфигурации |
| Пароль отправляется на сервер | **Никогда** — используется ECDSA challenge-response | Передаётся хеш | Передаётся хеш | Передаётся хеш |
| Шифрование медиа | **Отдельный ключ на каждый файл** | Да | Нет по умолчанию | Да |
| Звонки | **WebRTC + DTLS-SRTP** | WebRTC | Проприетарная реализация | Обычно через Jitsi/bridge |
| Развёртывание | **`./start.sh`** | Н/Д | Н/Д | Несколько сервисов |

---

## Содержание

1. [Технологический стек](#технологический-стек)
2. [Схема архитектуры](#схема-архитектуры)
3. [Криптографическая архитектура](#криптографическая-архитектура)
4. [Аудит безопасности](#аудит-безопасности)
5. [Карта реализации функций](#карта-реализации-функций)
6. [Поток данных — что видит сервер](#поток-данных--что-видит-сервер)
7. [Инфраструктура](#инфраструктура)
8. [Руководство по self-hosting](#руководство-по-self-hosting)
9. [Дорожная карта](#дорожная-карта)
10. [Мобильная стратегия](#мобильная-стратегия)

---

## Технологический стек

### Фронтенд

| Технология | Версия | Назначение |
|---|---|---|
| **Next.js** | 16.2.3 | App Router, SSR, standalone build, PWA |
| **React** | 19.2.5 | UI-библиотека |
| **TypeScript** | 5.9.3 | Типобезопасность на клиенте и сервере |
| **Tailwind CSS** | 3.4.19 | Utility-first стилизация, кастомная тема |
| **Framer Motion** | 11.18.2 | Анимации интерфейса |
| **Zustand** | 5.0.12 | Лёгкое управление состоянием |
| **Lucide React** | 0.577.0 | Набор иконок |
| **emoji-picker-react** | 4.18.0 | Выбор эмодзи в поле ввода |
| **Dexie** | 4.4.2 | Обёртка над IndexedDB: кэш сообщений, медиа и outbox |
| **idb** | 7.1.1 | Утилиты IndexedDB для кэша аватаров и ключей |
| **qrcode.react** | 4.2.0 | Генерация QR-кодов для привязки устройств |
| **react-image-crop** | 11.0.10 | Кроп аватаров |
| **browser-image-compression** | 2.0.2 | Клиентская оптимизация изображений перед загрузкой |
| **next-pwa** | 5.6.0 | Service Worker, офлайн-режим и push-обработчики |
| **Web Crypto API** | Native | Вся криптография: AES-GCM, ECDH, ECDSA, PBKDF2 |
| **Web Workers** | Native | Расшифровка вне главного потока |
| **Playwright** | 1.59.1 | End-to-end тестирование |
| **Vitest** | 3.2.4 | Unit-тестирование |

### Бэкенд

| Технология | Версия | Назначение |
|---|---|---|
| **Fastify** | 5.8.4 | HTTP-сервер + WebSocket upgrade |
| **@fastify/websocket** | 11.2.0 | Real-time сообщения, сигналинг звонков, typing, presence |
| **@fastify/jwt** | 10.0.0 | Сессионные токены |
| **@fastify/cors** | 11.2.0 | Настройка CORS |
| **@fastify/helmet** | 13.0.2 | Security headers |
| **@fastify/cookie** | 11.0.2 | httpOnly-cookie `fm_session` |
| **@fastify/multipart** | 10.0.0 | Загрузка файлов |
| **@fastify/rate-limit** | 10.3.0 | Защита от brute-force |
| **Drizzle ORM** | 0.45.2 | Типобезопасный доступ к PostgreSQL + миграции |
| **postgres** | 3.4.9 | PostgreSQL wire-protocol драйвер |
| **ioredis** | 5.10.1 | Redis-клиент для QR-токенов и кэша сессий |
| **@aws-sdk/client-s3** | 3.1029.0 | Работа с MinIO/S3 через presigned URL |
| **web-push** | 3.6.7 | VAPID push-уведомления |
| **otplib** | 13.4.0 | TOTP 2FA по RFC 6238 |
| **qrcode** | 1.5.4 | Генерация QR для привязки устройства |
| **Zod** | 3.25.76 | Валидация схем запросов |
| **Vitest** | 3.2.4 | Unit-тесты |
| **Supertest** | 7.2.2 | Интеграционное HTTP-тестирование |

### Инфраструктура

| Технология | Версия | Назначение |
|---|---|---|
| **Docker** | — | Контейнеризация |
| **Docker Compose** | v2 | Оркестрация сервисов (7 сервисов) |
| **PostgreSQL** | alpine | Постоянное хранилище пользователей, чатов, сообщений и устройств |
| **MinIO** | latest | S3-совместимое хранилище зашифрованных медиа |
| **Caddy** | 2-alpine | Reverse proxy и автоматический TLS через Let's Encrypt |
| **coturn** | 4.6 | TURN/STUN relay для обхода NAT в WebRTC |
| **Redis** | — | Опционально: QR-токены и multi-node deployment |

### Протоколы и стандарты

| Стандарт | Где используется |
|---|---|
| **AES-GCM-256** | Все сообщения, медиафайлы и шифрование vault |
| **ECDH P-256** | Обмен ключами в direct chats и упаковка групповых ключей |
| **ECDSA P-256 + SHA-256** | Беспарольная аутентификация через challenge-response |
| **PBKDF2 (210k итераций, SHA-256)** | Вывод ключа из passphrase для шифрования vault |
| **WebRTC + DTLS-SRTP** | Голосовые и видеозвонки |
| **VAPID / Web Push** | Push-уведомления в фоне |
| **TOTP RFC 6238** | Двухфакторная аутентификация |
| **WebAuthn** | Разблокировка vault аппаратным ключом / биометрией |
| **WebM/Opus** | Кодек голосовых сообщений |
| **Background Sync API** | Повторная отправка сообщений из офлайн-очереди |

---

## Схема архитектуры

```text
                         ┌──────────────────────────────────────────────────────────────┐
                         │                    DOCKER HOST (VPS)                         │
                         │                                                              │
    ┌──────────┐   HTTPS │   ┌────────────────────────────────────────────────────┐     │
    │ Браузер  │ ◄──────►│   │  Caddy :80/:443  (авто-TLS через Let's Encrypt)   │     │
    │ (клиент) │         │   │                                                    │     │
    │          │         │   │  onetothree.ru      ──► web:3000   (Next.js)       │     │
    │          │         │   │  api.onetothree.ru   ──► api:8080  (Fastify)       │     │
    └────┬─────┘         │   │  s3.onetothree.ru    ──► minio:9000 (MinIO)        │     │
         │               │   └────────────────────────────────────────────────────┘     │
         │               │                                                              │
         │  WebSocket    │   ┌────────────┐      ┌──────────────┐                       │
         │   (wss://)    │   │  Fastify   │◄────►│ PostgreSQL   │                       │
         │ ──────────────┤──►│ API :8080  │      │ :5432        │                       │
         │               │   │            │◄──┐  └──────────────┘                       │
         │               │   └────────────┘   │                                          │
         │               │         │          │  ┌──────────────┐                       │
         │  PUT/GET      │         │          └─►│ Redis        │                       │
         │ presigned URL │         │             │ :6379        │                       │
         │ ──────────────┤──►┌─────┴──────┐     └──────────────┘                       │
         │               │   │  MinIO     │                                            │
         │               │   │  :9000     │  ← зашифрованные медиа blobs               │
         │               │   └────────────┘                                            │
         │               │                                                              │
         │  UDP/TCP      │   ┌────────────────────────────────────────────┐             │
         │ TURN relay    │   │ coturn :3478 (host networking)             │             │
         │ ──────────────┤──►│ UDP relay :49152-65535                     │             │
         │               │   │ realm: onetothree.ru                       │             │
         │               │   └────────────────────────────────────────────┘             │
         │               └──────────────────────────────────────────────────────────────┘
         │
         │ Peer-to-peer при возможности
         │  ┌──────────┐
         └─►│ Браузер  │  ◄── DTLS-SRTP-зашифрованное аудио/видео
            │ (peer)   │      (сервер не видит медиаконтент)
            └──────────┘
```

### Где что выполняется

```text
┌─────────────────────────────────────────────┐
│             КЛИЕНТ (БРАУЗЕР)                │
│                                             │
│  ◆ Всё шифрование и расшифровка             │
│  ◆ Генерация и хранение приватных ключей    │
│  ◆ Блокировка/разблокировка vault           │
│  ◆ Шифрование сообщений перед отправкой     │
│  ◆ Шифрование медиа перед загрузкой         │
│  ◆ WebRTC peer connection                   │
│  ◆ Локальные кэши IndexedDB                 │
│  ◆ Упаковка групповых ключей                │
│  ◆ Проверка доверия и safety numbers        │
│  ◆ Batch-расшифровка через Web Worker       │
│  ◆ Service Worker: push и offline outbox    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│                СЕРВЕР (API)                 │
│                                             │
│  ◆ Хранение и доставка encrypted blobs      │
│  ◆ Регистрация пользователей                │
│  ◆ Проверка challenge-response              │
│  ◆ WebSocket relay сообщений                │
│  ◆ Сигналинг WebRTC (offer/answer/ICE)      │
│  ◆ Генерация presigned S3 URL               │
│  ◆ Отправка push-уведомлений                │
│  ◆ Rate limiting и access control           │
│  ◆ Delivery/read tracking                   │
│  ◆ Проверка TOTP 2FA                        │
│  ◇ НЕ выполняет: расшифровку контента,      │
│    доступ к ключам, чтение сообщений        │
└─────────────────────────────────────────────┘
```

---

## Криптографическая архитектура

### Аутентификация — ECDSA P-256 challenge-response

Пароль пользователя никогда не передаётся на сервер. Аутентификация строится на цифровой подписи challenge:[cite:1]

```text
 Регистрация:                                Вход:
 ───────────                                 ─────
 Клиент                   Сервер             Клиент                   Сервер
   │                         │                  │                         │
   │ generate ECDSA P-256    │                  │ читает vault из         │
   │ generate ECDH  P-256    │                  │ localStorage            │
   │                         │                  │ PIN → PBKDF2 →          │
   │ POST /auth/challenge    │                  │ расшифровка vault       │
   │ ───────────────────────►│                  │                         │
   │                         │                  │ POST /auth/challenge    │
   │       { nonce }         │                  │ ───────────────────────►│
   │◄────────────────────────│                  │                         │
   │                         │                  │       { nonce }         │
   │ sign(nonce, ecdsa_priv) │                  │◄────────────────────────│
   │                         │                  │                         │
   │ POST /auth/verify       │                  │ sign(nonce, ecdsa_priv) │
   │ { sig, ecdsa_pub,       │                  │                         │
   │   ecdh_pub, username }  │                  │ POST /auth/verify       │
   │ ───────────────────────►│                  │ { sig, username }       │
   │                         │                  │ ───────────────────────►│
   │ проверка подписи        │                  │                         │
   │ сохранение pub keys     │                  │ проверка по stored pub  │
   │ выдача JWT + cookie     │                  │ выдача JWT + cookie     │
   │                         │                  │                         │
   │     { token, user }     │                  │     { token, user }     │
   │◄────────────────────────│                  │◄────────────────────────│
```

**Что хранит сервер:** ECDSA public key, ECDH public key, username  
**Чего сервер не видит:** private keys, PIN/passphrase и содержимое vault в открытом виде.[cite:1]

### Шифрование vault

Vault содержит приватные ключи ECDSA и ECDH и шифруется пользовательским PIN или passphrase:[cite:1]

```text
                         ┌──────────────────────────────────────┐
  PIN пользователя ────► │ PBKDF2                               │
                         │ • 210 000 итераций                   │
  Случайная salt (16 B)► │ • SHA-256                            │
                         │ • Выход: 256-битный AES-ключ         │
                         └─────────────┬────────────────────────┘
                                       │
                                       ▼
                         ┌──────────────────────────────────────┐
  Содержимое vault ────► │ AES-GCM-256                          │
                         │ • Случайный IV 12 байт               │
                         │ • Аутентифицированное шифрование     │
                         └─────────────┬────────────────────────┘
                                       │
                                       ▼
                         ┌──────────────────────────────────────┐
                         │ VaultBlob в localStorage             │
                         │ {                                    │
                         │   version: 2,                        │
                         │   saltB64: "...",                   │
                         │   ivB64: "...",                     │
                         │   ciphertextB64: "..."              │
                         │ }                                    │
                         └──────────────────────────────────────┘
```

### Шифрование сообщений

В direct chats отправитель и получатель получают общий секрет через ECDH, после чего сообщение шифруется алгоритмом AES-GCM-256 на стороне клиента.[cite:1]

### Распределение группового ключа

В группах создаётся общий симметричный ключ, который упаковывается для каждого участника индивидуально через ephemeral ECDH и AES-GCM.[cite:1]

### Шифрование файлов

Файлы шифруются на клиенте до загрузки в MinIO, а сервер оперирует только presigned URL и зашифрованными blobs.[cite:1]

### Защита звонков

Звонки используют WebRTC, а сервер участвует только в сигналинге. Даже при TURN-релее через coturn медиапоток остаётся зашифрованным с помощью DTLS-SRTP.[cite:1]

### Сводка криптографических параметров

| Параметр | Значение |
|---|---|
| Симметричный шифр | AES-GCM-256 (256-битный ключ, 12-байтный IV, 128-битный auth tag) |
| Обмен ключами | ECDH P-256 |
| Аутентификация | ECDSA P-256 + SHA-256 |
| KDF для vault | PBKDF2-SHA-256, 210 000 итераций, salt 16 байт |
| Упаковка групповых ключей | Ephemeral ECDH → AES-GCM-256 для каждого участника |
| Шифрование звонков | DTLS-SRTP |
| Fingerprint ключа | SHA-256 от canonicalized JWK → safety number из 6 блоков |
| TOTP | HMAC-SHA1, 6 цифр, шаг 30 секунд |

---

## Аудит безопасности

**Последний аудит:** апрель 2026.[cite:1]

### Сильные стороны

- ✅ Используется только Web Crypto API, без сторонних JS-криптобиблиотек.
- ✅ AES-256-GCM со случайными IV и без повторного использования.
- ✅ ECDSA challenge-response — пароль не передаётся на сервер.
- ✅ Отдельное шифрование файлов.
- ✅ Parameterized SQL через Drizzle ORM.
- ✅ httpOnly, Secure и SameSite=Strict cookies.
- ✅ HSTS с preload и длительным max-age.[cite:1]

### Исправленные проблемы

- ✅ Server-side revocation JWT через denylist по `jti`.
- ✅ Механизм смены PIN для vault.
- ✅ Удалён `unsafe-eval` из production CSP.
- ✅ Увеличено число итераций PBKDF2 до 600k.
- ✅ Сокращено время жизни сессии.
- ✅ TOTP secret сохраняется только после успешной проверки.
- ✅ Permissions-Policy разрешает camera/mic для WebRTC.[cite:1]

### Известные ограничения

- Vault хранится в `localStorage`, хотя и в зашифрованном виде.
- Background Sync не поддерживается в iOS Safari.
- WebAuthn largeBlob поддерживается не везде, используется fallback.[cite:1]

---

## Карта реализации функций

| Функция | Клиент | Сервер | Протокол / стандарт |
|---|---|---|---|
| **E2EE direct messaging** | `lib/crypto.ts`, `lib/chat-crypto.ts`, `workers/crypto.worker.ts` | `routes/messages.ts`, `routes/ws.ts` | AES-GCM-256, ECDH P-256, WebSocket |
| **E2EE group messaging** | `lib/chat-logic.ts`, `hooks/use-group-key-distribution.ts` | `routes/chats.ts`, `routes/messages.ts` | AES-GCM-256, ephemeral ECDH wrapping |
| **Voice messages** | `components/chat/chat-input.tsx`, `hooks/use-media-recorder.ts` | `routes/storage.ts`, `routes/messages.ts` | WebM/Opus, AES-GCM-256, MinIO |
| **Video circles** | `components/chat/secure-video-circle.tsx`, `hooks/use-media-recorder.ts` | `routes/storage.ts` | WebM, E2EE |
| **Voice / video calls** | `hooks/use-webrtc.ts`, `components/call/active-call-overlay.tsx` | `routes/ws.ts` | WebRTC, DTLS-SRTP, ICE/TURN |
| **Screen share** | `hooks/use-webrtc.ts` | `routes/ws.ts` | WebRTC getDisplayMedia |
| **File sharing** | `hooks/use-send-media.ts`, `lib/media-crypto.ts` | `routes/storage.ts` | AES-GCM-256, S3 PUT/GET |
| **Push notifications** | `lib/push-subscription.ts`, `hooks/use-phantom-push.ts` | `routes/push.ts`, `lib/push.ts` | VAPID, Web Push API |
| **2FA (TOTP)** | `components/settings-modal.tsx` | `routes/auth.ts` | TOTP RFC 6238 |
| **Multi-device** | Панели и модальные окна устройств | `routes/auth.ts`, `lib/qr-link-store.ts`, `routes/devices.ts` | QR linking, vault sync |
| **Vault encryption** | `lib/vault.ts`, `lib/vault-keyring.ts` | `routes/vault.ts` | PBKDF2 + AES-GCM-256 |
| **Passwordless auth** | `lib/auth/crypto-login.ts` | `routes/auth.ts` и crypto-helpers | ECDSA challenge-response |
| **Read receipts** | `hooks/use-read-receipts.ts` | `routes/messages.ts` | WebSocket |
| **Typing indicators** | `hooks/use-typing-indicator.ts` | `routes/ws.ts` | WebSocket |
| **Presence / online** | `hooks/use-presence-sync.ts` | `routes/users.ts`, `lib/presence.ts` | WebSocket |
| **Offline outbox** | `lib/outbox.ts`, delivery sync hooks | `routes/messages.ts` | IndexedDB, Background Sync API |
| **Admin panel** | `app/admin/page.tsx` | `routes/admin.ts` | Статистика, moderation, reports |
| **PWA install** | install hooks, manifest, banners | — | Web App Manifest, Service Worker |
| **Trust verification** | `lib/trust-store.ts`, `lib/crypto.ts` | — | SHA-256 fingerprint comparison |
| **Invite links** | `app/join/[code]/page.tsx` | `routes/chats.ts` | Одноразовые и постоянные invite-коды |

---

## Поток данных — что видит сервер

Это один из ключевых разделов: One To Three работает по модели **zero-trust server**.[cite:1]

### Сервер хранит

- ✅ Зашифрованные message blobs.
- ✅ Зашифрованные media blobs в MinIO.
- ✅ Зашифрованные vault backup.
- ✅ Зашифрованные групповые ключи в упакованном виде.
- ✅ Публичные ключи ECDSA и ECDH.
- ✅ Usernames.
- ✅ Timestamp-метаданные.
- ✅ Состав участников чатов.
- ✅ Сессии устройств.
- ✅ Push subscription endpoints.
- ✅ Delivery receipts.[cite:1]

### Сервер не видит

- ❌ Plaintext сообщений.
- ❌ Содержимое медиа.
- ❌ Приватные ключи.
- ❌ PIN/passphrase для vault.
- ❌ Group key plaintext.
- ❌ Аудио и видео звонков.
- ❌ Локально расшифрованный кэш пользователя.[cite:1]

### Если сервер скомпрометирован

При полном доступе к БД атакующий получает в основном метаданные: usernames, timestamps, membership и другую служебную информацию, но не содержимое сообщений и файлов в открытом виде.[cite:1]

Итоговая модель безопасности здесь следующая: **конфиденциальность содержимого сохраняется даже при полном компромиссе сервера**, но метаданные общения остаются видимыми.[cite:1]

---

## Инфраструктура

### Docker Compose в production

`docker-compose.prod.yml` описывает 7 сервисов: `caddy`, `web`, `api`, `db`, `db-migrate`, `minio` и `coturn`.[cite:1]

### Детали сервисов

| Сервис | Образ | Ресурсы | Health check |
|---|---|---|---|
| **db** | `postgres:alpine` | 1 CPU, 512 MB | `pg_isready` каждые 5s |
| **minio** | `minio/minio:latest` | 2 CPU, 512 MB | `mc ready local` каждые 5s |
| **db-migrate** | Custom (`node:20-alpine`) | 0.25 CPU share | Одноразовый запуск |
| **api** | Custom (`node:20-alpine`) | 4 CPU, 1 GB, read-only fs | `GET /health` каждые 10s |
| **web** | Custom (`node:20-alpine`) | 4 CPU, 1.5 GB | `GET /` каждые 15s |
| **coturn** | `coturn/coturn:4.6` | Host networking | — |
| **caddy** | `caddy:2-alpine` | 1 CPU, 256 MB | — |

### Постоянные тома

| Том | Сервис | Содержимое |
|---|---|---|
| `pgdata` | PostgreSQL | Данные БД |
| `minio_data` | MinIO | Зашифрованные медиафайлы |
| `caddy_data` | Caddy | TLS-сертификаты |
| `caddy_config` | Caddy | Автогенерируемая конфигурация |

### Усиление безопасности

- API-контейнер работает с `read_only: true` и ограниченным `tmpfs`.
- Основные контейнеры запускаются не от root.
- Caddy выставляет HSTS, X-Frame-Options, nosniff и другие защитные заголовки.
- На auth endpoints включён rate limiting.
- Контейнеры используют DNS pinning на `host-gateway`.[cite:1]

### `start.sh` — production launcher

```bash
./start.sh              # Собрать и запустить все сервисы
./start.sh stop         # Остановить контейнеры
./start.sh restart      # Перезапустить без пересборки
./start.sh logs         # Смотреть логи
./start.sh status       # Проверить статус и health
./start.sh update       # git pull + rebuild + restart
./start.sh backup       # Резервная копия PostgreSQL
```

При первом запуске скрипт автоматически генерирует `JWT_SECRET`, `WEBHOOK_SECRET`, VAPID-ключи, синхронизирует связанные переменные окружения и валидирует обязательные поля перед стартом.[cite:1]

---

## Руководство по self-hosting

### Требования к железу

| Компонент | Минимум | Рекомендуется |
|---|---|---|
| CPU | 2 ядра | 4 ядра |
| RAM | 4 GB | 6+ GB |
| Диск | 20 GB SSD | 50+ GB SSD |
| Сеть | 100 Mbps | 1 Gbps |
| ОС | Любой Linux с Docker | Ubuntu 22.04 / Debian 12 |

### Обязательные открытые порты

| Порт | Протокол | Сервис | Примечание |
|---|---|---|---|
| **80** | TCP | Caddy | HTTP → HTTPS redirect + ACME |
| **443** | TCP | Caddy | HTTPS |
| **3478** | TCP + UDP | coturn | TURN/STUN |
| **49152–65535** | UDP | coturn | TURN media relay range |

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49152:65535/udp
```

### Настройка DNS

| Запись | Тип | Значение | Прокси |
|---|---|---|---|
| `yourdomain.com` | A | `<server IP>` | Cloudflare можно |
| `api.yourdomain.com` | A | `<server IP>` | Cloudflare можно |
| `s3.yourdomain.com` | A | `<server IP>` | Cloudflare можно |
| `turn.yourdomain.com` | A | `<server IP>` | **Только DNS, без proxy** |

### Конфигурация Cloudflare

TURN-хост **обязательно** должен быть в режиме **DNS only**, потому что orange-cloud proxy не поддерживает UDP-трафик, необходимый для WebRTC-звонков.[cite:1]

### Быстрый старт

```bash
# 1. Клонирование
git clone https://github.com/user/OneToThree.git
cd OneToThree

# 2. Конфигурация
cp .env.prod.example .env.prod
# Заполните обязательные поля:
# POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD,
# TURN_EXTERNAL_IP, TURN_PASSWORD,
# CORS_ORIGIN, VAPID_SUBJECT

# 3. Запуск
./start.sh

# 4. Проверка
./start.sh status
```

### Переменные окружения

| Переменная | Генерируется автоматически | Назначение |
|---|---|---|
| `POSTGRES_PASSWORD` | Нет | Пароль БД |
| `MINIO_ROOT_PASSWORD` | Нет | Пароль S3-хранилища |
| `TURN_EXTERNAL_IP` | Нет | Внешний IP сервера |
| `TURN_PASSWORD` | Нет | Данные доступа TURN |
| `CORS_ORIGIN` | Нет | Основной домен |
| `VAPID_SUBJECT` | Нет | Контакт для push |
| `JWT_SECRET` | **Да** | Ключ подписи сессий |
| `WEBHOOK_SECRET` | **Да** | Внутренний webhook-secret |
| `VAPID_PUBLIC_KEY` | **Да** | Публичный push-ключ |
| `VAPID_PRIVATE_KEY` | **Да** | Приватный push-ключ |
| `DATABASE_URL` | **Да** | Собирается из `POSTGRES_*` |
| `NEXT_PUBLIC_TURN_*` | **Да** | Синхронизируется из `TURN_*` |

---

## Дорожная карта

### Уже реализовано

- [x] E2EE direct messaging
- [x] E2EE group messaging
- [x] Голосовые сообщения
- [x] Video circles
- [x] Голосовые и видеозвонки
- [x] Демонстрация экрана
- [x] Зашифрованный файлообмен
- [x] Push-уведомления
- [x] 2FA / TOTP
- [x] Multi-device через QR
- [x] Passwordless auth
- [x] Vault encryption
- [x] Offline outbox
- [x] Read receipts
- [x] Typing indicators
- [x] Presence tracking
- [x] Message burn
- [x] Reply-to messages
- [x] Профили пользователей
- [x] Админ-панель
- [x] PWA support
- [x] i18n (English + Russian)
- [x] Safety numbers
- [x] Trust pinning
- [x] Device re-authorization
- [x] Навигация по voice messages
- [x] Swipe-to-lock recording
- [x] Background Sync для офлайн-очереди.[cite:1]

### В работе / запланировано

- [ ] **WebAuthn unlock для vault** — инфраструктура уже есть, UI ещё не подключён.
- [ ] **Поддержка стикеров** — строки локализации уже есть, реализация в процессе.
- [ ] **Social links API** — модель в профиле предусмотрена, фронтенд неполный.
- [ ] **Очистка медиа по retention-policy** — нужен scheduler/config.
- [ ] **Полноценный multi-node через Redis** — база готова, масштабирование ещё не полностью обкатано.
- [ ] **Гранулярные права администраторов групп** — role system уже есть, детализация ещё впереди.[cite:1]

---

## WebSocket-протокол

### Сообщения от клиента к серверу

| Тип | Payload | Назначение |
|---|---|---|
| `chat_message` | `chat_id, content, iv, media_path?, media_type?, media_iv?, reply_to_id?, burn_at?` | Отправка зашифрованного сообщения |
| `webrtc_signal` | `targetUserId, signalData` | WebRTC offer/answer/ICE/media_state |
| `call_invite` | `chat_id, is_video` | Инициация звонка |
| `call_leave` | `chat_id` | Выход из звонка |
| `message_read` | `chat_id, message_id` | Read receipt |
| `typing_start` | `chat_id` | Начало ввода |
| `typing_stop` | `chat_id` | Окончание ввода |
| `presence_ping` | — | Heartbeat и обновление `last_seen` |

### Сообщения от сервера к клиенту

| Тип | Payload | Назначение |
|---|---|---|
| `chat_message` | Полный объект сообщения | Входящее зашифрованное сообщение |
| `chats_updated` | — | Изменения в списке чатов |
| `message_deleted` | `message_id, chat_id` | Удаление сообщения |
| `webrtc_signal` | `fromUserId, signalData` | Relay WebRTC-сигнала |
| `call_invite` | `chat_id, callerId, is_video` | Уведомление о входящем звонке |
| `typing_start/stop` | `chat_id, user_id` | Relay typing-state |

---

## Схема базы данных

В документе описаны основные сущности: `users`, `devices`, `pushSubscriptions`, `chats`, `chatMembers`, `messages` и `messageDeliveries`, включая хранение публичных ключей, ciphertext-полей, membership-структуры, device state и delivery tracking.[cite:1]

Это отражает основную архитектурную идею проекта: сервер знает структуру коммуникации и служебные метаданные, но не видит содержимое сообщений в открытом виде.[cite:1]

---

## Структура проекта

```text
OneToThree/
├── client/                    # фронтенд на Next.js 16
│   ├── src/
│   │   ├── app/               # App Router страницы
│   │   ├── components/        # React-компоненты
│   │   ├── hooks/             # кастомные hooks
│   │   ├── lib/               # криптография, vault, кэши
│   │   ├── locales/           # локализация (en, ru)
│   │   ├── store/             # Zustand stores
│   │   └── workers/           # Web Workers
│   ├── public/                # статические ресурсы, SW
│   ├── Dockerfile
│   └── Dockerfile.dev
│
├── server/                    # бэкенд на Fastify
│   ├── src/
│   │   ├── routes/            # HTTP и WS endpoints
│   │   ├── ws/                # WebSocket registry
│   │   ├── lib/               # business logic
│   │   ├── db/                # схема Drizzle ORM
│   │   └── types/             # типы TypeScript
│   ├── drizzle/               # SQL-миграции
│   ├── Dockerfile
│   └── Dockerfile.dev
│
├── docker/
│   ├── coturn/                # конфигурация TURN
│   └── db-migrate/            # контейнер миграций
│
├── docker-compose.yml         # dev
├── docker-compose.prod.yml    # production
├── Caddyfile                  # reverse proxy + TLS
├── start.sh                   # production launcher
├── drizzle.config.ts          # конфиг ORM
├── .env.prod.example          # шаблон окружения
└── FOSS.md                    # техническая документация
```

---

## Мобильная стратегия

### Текущее состояние: PWA

Проект поставляется как полноценная PWA, устанавливаемая на Android и iOS.[cite:1]

| Возможность | Android Chrome | iOS Safari (16.4+) |
|---|---|---|
| Установка на домашний экран | ✅ | ✅ |
| Push-уведомления | ✅ | ✅ |
| Background sync | ✅ | ❌ |
| Биометрическая разблокировка через WebAuthn | ✅ | ✅ |
| Wake Lock во время звонка | ✅ | ❌ |
| MediaSession | ✅ | ⚠️ Частично |
| Действия во входящем звонке | ✅ | ⚠️ Частично |
| Share Target | ✅ | ❌ |
| Badging API | ✅ | ✅ |

### Уже реализовано в PWA

- WebAuthn / Passkeys для разблокировки vault.
- MediaSession API для управления звонками.
- Wake Lock во время звонков.
- Badging API для счётчика непрочитанных.
- Auto-lock по таймауту бездействия.
- Push с действиями Accept / Decline для входящих звонков.
- Share Target для приёма файлов из других приложений.
- Orientation lock для видеозвонков.
- Background Sync для отложенной отправки.[cite:1]

### Дальше: нативные приложения

**Вариант A: Capacitor** — рекомендованный следующий шаг, позволяет обернуть текущий Next.js-код в native WebView, оценивается примерно в 4–6 недель и открывает доступ к CallKit, Foreground Service и системному contact picker.[cite:1]

**Вариант B: React Native** — полный перенос UI в нативный стек, 4–6 месяцев работы, но с лучшим native UX.[cite:1]

**Вариант C: Flutter** — полная перепись на Dart, 6–9 месяцев, единая кодовая база для нескольких платформ.[cite:1]

---

## Лицензия

Проект распространяется как open-source под лицензией **AGPL-3.0-only**.[cite:1]

---

<div align="center">

**One To Three** — *Ваши сообщения. Ваш сервер. Ваши ключи.*

</div>
