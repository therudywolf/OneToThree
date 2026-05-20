# Migration Notes

Этот файл отслеживает миграции БД и инвариантов формата сообщений, которые вводит
многофазный рефакторинг `overhaul/*`. Каждая запись = одна миграция, упорядочены
по фазам из плана.

Формат записи:
- Фаза / PR
- Что меняется
- Совместимость (backward/forward)
- Как откатить

---

## Фаза 1.1 — envelope.kind на вложениях

- Добавить необязательное поле `kind: 'voice' | 'video_circle' | 'video' | 'image' | 'file'`
  в attachment-envelope (`client/src/lib/attachment-envelope.ts`).
- Backward: старые сообщения без `kind` рендерятся по текущим эвристикам (MIME / filename).
- Forward: новые клиенты всегда выставляют `kind`, старые клиенты игнорируют поле.

## Фаза 1.2 — envelope `p13: 'album'`

- Новый тип envelope для множественных вложений в одном сообщении:
  `{ p13: 'album', v: 1, items: Array<{ path, iv, mimeType, kind, thumbhash? }>, caption? }`.
- БД не меняется — хранится как обычный `messages.content` (ciphertext).
- Старые клиенты не умеют рендерить альбом: показывают fallback-иконку «N вложений».

## Фаза 1.5 — сервер удаляет полнотекстовый поиск

- В `server/src/routes/messages.ts` удаляется `GET /messages/search?q=`.
- Клиент переключается на IndexedDB-индекс расшифрованных `plaintext`.
- Откат: вернуть эндпоинт, однако делать этого не следует — текущий поиск ломает E2E.

## Фаза 1.5 — OOB-подтверждение при QR-логине (планируется)

- На данный момент (overhaul-phase-1.5) подтверждение ещё не применяется —
  сервер продолжает использовать существующую схему QR-bind без нового
  состояния. Изменения перенесены в задачу `phase3-integrate`, где связывание
  устройств естественным образом опирается на X3DH-бандлы и подпись
  identity-ключом.
- Для снижения рисков в текущей ветке: добавлена диагностика камеры,
  предпочтительно `BarcodeDetector`, обязательный `loadedmetadata` на видео
  (см. `login-qr-device-panel.tsx`).

## Фаза 1.5 — `public_open` (решение отложено)

- Переименование enum `chat_type = 'public_open'` отложено (широкое
  использование в API/БД). Вместо этого:
  - UI-предупреждение о plaintext-режиме показывается в `create-chat-modal`
    и баннере чата (`public_open_banner`).
  - Документация (`docs/security-policy.md` в phase6) явно фиксирует, что
    `public_open` — это публичный канал без E2E.
- Полное переименование на `public_plaintext` запланировано вместе с
  каналами (phase5.1).

## Фаза 1.5 — WebRTC signaling (решение отложено)

- Шифрование SDP/ICE по идентификаторам планируется вместе с Double Ratchet
  (phase3-integrate) и LiveKit SFU (phase4-e2ee).
- На текущем этапе trust boundary сервера не меняется: сервер по-прежнему
  видит кандидатов. Это зафиксировано в threat model и будет закрыто в 4.3.

## Фаза 1.5 — vault export v4 (Argon2id)

- `client/src/lib/vault.ts` теперь пишет блобы в версии `4`.
- В blob добавляется поле `argon2: { t, m, p }` (RFC 9106, по умолчанию
  `t=3, m=64 MiB, p=1`, OWASP 2024 baseline).
- Импорт поддерживает `v1..v4`: v1–v3 читаются через PBKDF2, v4 — через Argon2id.
- `upgradeVaultBlob(blob, pin)` — ре-упаковывает v1–v3 в v4 без export/import.
- Старые экспорты `13vault.key` / `forest_vault_key.json` остаются валидными.

## Фаза 1.5 — сервер удаляет `GET /api/messages/search`

- Маршрут `GET /api/messages/search` полностью удалён из
  `server/src/routes/messages.ts` (Track E cleanup) — раньше он отдавал
  пустую `410 Gone`-заглушку, теперь путь падает в стандартный `404`.
- Клиентский хелпер `searchChatMessages` удалён; использовать
  `@/hooks/use-local-search` (в памяти) и `searchLocalMessages`
  (IndexedDB-индекс в `@/lib/message-cache`).
- Интеграционный тест `messages-flow.test.ts` ожидает `404`.

## Фаза 2.1 — `themeStore` split: shellMode × palette

- Добавлено поле `shellMode: 'terminal' | 'md3'` в стор `themeStore` —
  оно контролирует **шрифты / скругления / CRT-overlay** и полностью
  независимо от палитры.
- Палитра (`theme: ThemeId`) теперь отвечает только за цвета.
- `resolveThemeAppearance({…, shellMode})` даёт объединённые токены;
  shell-overrides всегда накладываются поверх палитры.
- `<html>` получает три атрибута: `data-theme` (legacy), `data-palette`
  (новый) и `data-shell`.
- Persisted state: `fm_chromatic_config` → `version: 2`. Миграция
  v1→v2 восстанавливает `shellMode` из старого `theme` (md3dark/md3light →
  `md3`, всё прочее → `terminal`).

## Фаза 2.2 — chromatic tokens + codemod

- `client/tailwind.config.ts` расширен семантическими алиасами:
  `primary` (=neon-red), `accent` (=neon-cyan), `border` (=border-strong),
  `elevated` (=surface-elevated), `muted` (=text-muted), `overlay`,
  `overlay-strong`.
- `scripts/codemod-theme-tokens.mjs` — одноразовый codemod, переписавший
  ~920 хард-кодных Tailwind-утилит (`bg-zinc-*`, `text-red-*` и т.д.)
  в токен-совместимые варианты. Запускается как
  `node scripts/codemod-theme-tokens.mjs --write`.
- `scripts/audit-security-lint.mjs` обновлён: `console.debug` разрешён,
  `console.log` / `console.info` запрещены. Сейчас в коде **0 нарушений**,
  `STRICT=1 npm run audit:security:strict` проходит.
- Theme token enforcement (no hardcoded colors, no `[#hex]` literals) is handled
  by `scripts/audit-security-lint.mjs` (`STRICT=1` mode).

## Фаза 3.1 — библиотека Double Ratchet

- `client/src/lib/ratchet/` — X25519/Ed25519 keys, HKDF chain KDFs, X3DH,
  Double Ratchet state machine, sender keys (group), IndexedDB session store,
  safety numbers (SHA-512 × 5200 итераций, 60 десятичных цифр).
- Зависимости: `@noble/curves@^1.9`, `@noble/hashes@^1.8`.
- Тесты: `client/src/lib/ratchet/ratchet.test.ts` (X3DH, DR alternating,
  out-of-order, tamper, safety numbers).

## Фаза 3.2 — key directory (серверная часть)

- Новые таблицы: `identity_keys`, `signed_prekeys`, `onetime_prekeys`
  (миграция `drizzle/0027_add_ratchet_prekeys.sql`, добавляет только новые
  объекты, существующие не трогает).
- Новые эндпоинты под `/api/keys/*`:
  - `POST /identity` — публикация/ротация identity-пары (монотонный `generation`).
  - `POST /signed-prekey` — публикация подписанного pre-key.
  - `POST /one-time` — bulk-загрузка one-time pre-keys (квота 200/пользователя).
  - `GET /inventory` — сколько OPK остаётся.
  - `GET /bundle/:userId` — атомарная выдача bundle + consume одного OPK
    (Cache-Control: no-store).

## Фаза 3.3 — messages.protocol_version и клиентский session-manager

- `ALTER TABLE messages ADD COLUMN protocol_version INT NOT NULL DEFAULT 1`
  + nullable `dr_header TEXT` (миграция `0028_messages_protocol_version.sql`).
  Поле `dr_header` — base64url-JSON с `{ dhPub, prevN, n }`, nullable для v1.
- `client/src/lib/ratchet/session-manager.ts` — high-level обёртка:
  `bootstrapSession` (Alice), `acceptSession` (Bob), `encryptForPeer`,
  `decryptFromPeer`, `sessionFingerprint`, `publishLocalBundle`.
- `client/src/lib/chat-crypto.ts` получил `encryptOutboundTextV2` /
  `decryptInboundTextV2` — выбирают v1/v2 на лету:
  если есть DR-session в IndexedDB, идёт по v2; иначе fallback на legacy v1.
- Совместимость: legacy-клиент продолжает читать/писать v1. v2-сообщения
  от нового клиента к старому не декодируются — отправитель проверяет
  `protocol_version` целевого чата в будущем (сейчас пробрасывается
  через поле `messages.protocol_version`).
- Откат: выставить env-флаг `DR_DISABLED=1` (TODO в phase6 — сейчас
  `encryptOutboundTextV2` опирается только на наличие session, поэтому
  достаточно удалить IndexedDB `forest-ratchet`).

## Фаза 4.1 — coturn hardening + turns:// over 5349

- `docker/coturn/turnserver.conf` переписан: добавлены `tls-listening-port`,
  ACME-сертификат из `caddy_data`, список `denied-peer-ip` для private
  ranges, узкий relay-диапазон 49160..49200.
- `Caddyfile` получил блок `turn.onetothree.ru` (респонд 404, TLS-only) —
  только для ACME-сертификата, который `scripts/sync-turn-certs.sh`
  копирует в `docker/coturn/tls/` и перезапускает coturn.
- `docker-compose.prod.yml` монтирует `docker/coturn/tls` и добавляет
  healthcheck по TCP 3478.
- **Ограничения Cloudflare**: `turn.onetothree.ru` DNS-only (gray cloud).
  UDP 49160..49200 и TCP 3478/5349 должны быть открыты на хост-firewall.
- Клиентский `NEXT_PUBLIC_TURN_URLS` теперь корректно подставляет цепочку
  `turn:turn.*:3478` + `turns:turn.*:5349` — читаем в `.env.prod` пример.

## Фаза 4.2 — LiveKit SFU + /api/call/token

- Новый сервис `livekit` в `docker-compose.prod.yml`
  (`livekit/livekit-server:v1.8`, host networking, UDP 50000..50100, TCP 7881).
- Конфиг `docker/livekit/livekit.yaml` — ключи из env, Redis shared с api.
- Caddyfile: блок `lk.onetothree.ru` → reverse_proxy в `host.docker.internal:7880`
  (WSS signaling). Cloudflare DNS-only обязательно — SFU медиапоток это UDP.
- `server/src/routes/call.ts`:
  - `POST /api/call/token { room, can_publish?, can_subscribe? }` —
    выдаёт HS256 JWT с LiveKit video grant (`roomJoin`, `canPublish`, `canSubscribe`).
  - `GET /api/call/config` — клиент проверяет, включён ли LiveKit.
  - Без `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `LIVEKIT_URL` эндпоинт
    отдаёт 503, клиент падает на существующий mesh-WebRTC.
- Подпись JWT — `node:crypto.createHmac('sha256', apiSecret)`, без новых
  зависимостей (livekit-server-sdk не нужен для token issuance).

## Фаза 4.3 — LiveKit Insertable Streams E2EE (архитектура)

- Медиа внутри SFU уже шифруется DTLS-SRTP между клиентом и livekit-server,
  но сам SFU видит плейнтекст → это НЕ E2EE. Для полного E2EE план:
  1. Клиент после `join` запрашивает sender-key (phase 3.1) для комнаты.
  2. Активирует `Room.options.e2ee = true` с `ExternalE2EEKeyProvider`.
  3. Ключ — 32 байта, выводится через HKDF(roomId, sender-key-secret).
  4. При ротации ключа (participant join/leave) переходим на новый
     sender-key chain и рассылаем `ratchetKey` через `localParticipant.publishData`.
- Зависимость: `@livekit/client` + `@livekit/e2ee-client` на клиенте
  (ещё не установлены; Call UI — в следующей итерации).
- Документация сохранена здесь, чтобы не потерять инвариант «sender key
  не выходит из комнаты».

## Фаза 5.1 — `chat_type = 'channel'` (две миграции)

- Новый тип чата с единственным постящим автором (Telegram-style broadcast).
- **Важно**: PostgreSQL запрещает использовать свежедобавленное значение
  enum внутри той же транзакции (даже для `NOT VALID` CHECK). drizzle-orm
  оборачивает каждую `.sql`-миграцию в `BEGIN/COMMIT`, поэтому добавление
  значения и CHECK разбиты по двум файлам:
  - `0029_channels.sql` — только `ALTER TYPE chat_type ADD VALUE 'channel'`.
  - `0030_channels_members.sql` — `channel_role` enum, колонка на
    `chat_members`, CHECK-констрейнт и discovery-индекс.
- CHECK `chat_members_channel_role_consistency` гарантирует, что
  `channel_role` задаётся только для `chat.type = 'channel'`.
- Индекс `chats_channel_public_idx` для discovery UI.
- Клиентская UI-часть (отдельный create-modal, discovery feed) остаётся
  в phase 6, когда параллельно переписывается chat creation flow.

## Фаза 5.2 — стикеры

- Новый enum `sticker_format` (`tgs`/`lottie`/`static`/`webm`) и таблицы
  `sticker_packs`, `stickers` (миграция `0031_stickers.sql` — сдвинута
  с `0030` из-за разбиения channel-миграций выше).
- `sticker_packs.tg_source` хранит Telegram `short_name` для импорта
  через Bot API (опционально — токен Bot API задаётся оператором).
- Envelope `p13: 'sticker'` уже определён в `attachment-envelope.ts`; UI
  `<StickerPicker>` и Lottie/TGS-плеер (`dotlottie-web` / `lottie-web`)
  устанавливаются отдельно (dev-UX фаза). Совместимость: legacy-клиенты
  видят fallback «стикер (требуется обновление)».

## Post-audit (PR A) — inline операционные фиксы

Эти изменения не трогают схему БД, но перечисляются тут как единое место
истории инвариантов.

- **`server/src/routes/call.ts`** теперь читает `LIVEKIT_API_KEY` /
  `LIVEKIT_API_SECRET` через `readSecret()` (Docker secrets
  first), а не напрямую из `process.env`. Совместимость: в dev-режиме
  plain-env всё ещё работает, в проде — монтируется через
  `/run/secrets/livekit_api_*`.
- **`docker-compose.prod.yml`**: сервис `api` получил mount секретов
  `livekit_api_key`, `livekit_api_secret` + переменные `*_FILE`. Сервис
  `livekit` запускается под `docker/livekit/entrypoint.sh`, который
  собирает `LIVEKIT_KEYS` из секретов и делает `exec /livekit-server`.
  Сервис `caddy` получил `host.docker.internal:host-gateway` —
  необходимо на Linux VPS, где Docker Desktop не авто-мапит этот хост.
- **`docker/livekit/livekit.yaml`**: убран блок `keys:` с
  `${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}` — LiveKit v1.8 не делает
  env-substitution, так что вместо него ключи попадают через
  `LIVEKIT_KEYS` из entrypoint'а.
- **`docker/coturn/turnserver.conf`**: убран `realm=${TURN_REALM:-…}`
  (coturn не делает substitution; realm задаётся CLI-флагом в
  compose-`command:`).
- **`startup.sh`**: теперь генерит `secrets/livekit_api_key` через внутренний helper
  (`APIforest_*`) и `secrets/livekit_api_secret` (hex-64). Существующие
  инсталляции: удалите `./secrets/.initialized` и заново инициализируйте
  LiveKit-ключи либо допишите файлы вручную.
- **`startup.sh update`**: `detect_update_services` теперь распознаёт
  `docker/livekit/*` → перезапуск `livekit`, и выводит warning о
  необходимости вручную синхронизировать TURN TLS
  (`scripts/sync-turn-certs.sh`) при изменениях `docker/coturn/tls/*`.
  Дефолтный список сервисов при «пустом» диффе расширен до
  `(api web caddy coturn livekit)`.
- **`startup.sh`** доменная синхронизация дополнительно заполняет
  `LIVEKIT_URL=wss://lk.<domain>` и `NEXT_PUBLIC_LIVEKIT_URL` — клиенту
  не нужно иметь секреты, ему нужен только публичный URL.

Откат: каждый пункт изолирован и может быть отменён возвратом файла из
git. Ключи из `secrets/livekit_api_*` безопасны к удалению — при
отсутствии файла api-эндпоинт отдаёт 503, клиент падает на mesh WebRTC.

---

## Операционные инструкции

Все миграции применяются через drizzle:

```bash
npm run db:generate
npm run db:push
```

В проде — через `startup.sh` (flag `--migrate`) и обязательный backup перед применением.
