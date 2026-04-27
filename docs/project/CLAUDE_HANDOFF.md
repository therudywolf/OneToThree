# CLAUDE HANDOFF — START HERE

Last updated: 2026-04-22e (relay-only calls update)

## Goal

Две независимые темы — MD3 и Cyberpunk/Terminal — должны работать идеально. Runtime-корректность первична. UI/UX полировка — второй приоритет, но обязательно для обоих шеллов.

## Source Of Truth

1. `WORKPLAN.md` — полный бэклог и структура спринтов.
2. `AGENT_PROGRESS.md` — краткий снимок состояния + риски.
3. Этот файл — чеклист запуска для Claude.

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
- `[data-theme="md3dark/light"]` и `[data-theme="cyberpunk"]` — только palette-токены, никаких компонентных правил.
- Никаких утечек: MD3 не должен получать monospace, terminal не должен получать Google Sans.

---

## Текущее состояние (2026-04-22)

### Инциденты и хотфиксы (добавлено 2026-04-22d)

- [x] **`start.sh update` падал на миграции**: `type "channel_role" already exists`.
  - Причина: дублирующая DDL в `server/drizzle/0035_same_molly_hayes.sql`.
  - Фикс: миграция сделана идемпотентной (`IF NOT EXISTS`/`duplicate_object` guards).
  - Коммит: `03611fe` (`fix(db): make 0035 migration idempotent`).
- [x] После фикса миграций `db-migrate` проходит успешно на проде (по логам `start.sh update`).
- [ ] **Открытый блокер media upload**: `STORAGE_PUT_403 SignatureDoesNotMatch` при `PUT` в `s3.onetothree.ru` (HAR: `Har/gs.har`, `Har/gol.har`).
  - Диагностика: presigned URL подписывает `content-length` (`X-Amz-SignedHeaders=content-length;host`), что ломается за proxy/CDN.
  - Кодовый фикс подготовлен локально: убрать `ContentLength` из presign PUT (`server/src/lib/s3.ts`, `server/src/routes/storage.ts`).
  - Требуется: commit+push+deploy, затем повторный runtime тест медиа/ГС.
- [ ] **Открытый UX/runtime дефект**: сообщение может становиться пустым/`[DECRYPT_FAIL]` после возврата в чат.
  - Кодовый фикс подготовлен локально: fallback из message cache по `message.id` в `use-load-chat-messages`.
  - Требуется: commit+push+deploy и повторная проверка сценария.

### Call transport policy update (2026-04-22e)

- [x] Принята новая политика: **звонки только через relay/TURN**, без STUN-only и без клиентских fallback-веток.
- [x] Реализовано:
  - `server/src/routes/webrtc.ts` — `/api/turn` и `/api/ice-servers` возвращают `503 TURN_NOT_CONFIGURED`, если relay не настроен.
  - `client/src/lib/ice-servers.ts` — убран fallback на public STUN; `getIceServers()` теперь требует TURN relay.
  - `client/src/hooks/use-webrtc.ts` — убран runtime fallback/auto-switch path при ICE-fail/timeout.
- [x] Локальная проверка: `typecheck` + `lint` (client) PASS, `server/src/routes/webrtc.test.ts` PASS.
- [!] ВАЖНО: это **жёсткий режим**. Если TURN (Cloudflare TURN/coturn) недоступен, звонок не поднимется.

### Закрыто (Sprint 8)
- [x] `[DECRYPT_FAIL]` при повторном входе в чат
- [x] MD3: чаты не открывались (та же причина — async drCtx)
- [x] MD3 left rail кнопки — пересчитан размер
- [x] Sidebar action buttons overlap — CSS фикс
- [x] Theme isolation MD3/Cyberpunk — убраны все утечки из `[data-theme]`

### Открыто — приоритет 1 (Runtime)
→ Sprint 10 в WORKPLAN.md

1. Invite flow (`join/[code]`) — runtime не валидировался
2. Direct fanout 2+ устройства — runtime не валидировался
3. Saved Messages мульти-девайс — runtime не валидировался

### Открыто — приоритет 2 (UI/UX обоих шеллов)
→ Sprint 9 в WORKPLAN.md

4. MD3: message bubbles, hover actions, desktop header, micro-spacing
5. Cyberpunk: terminal bubbles, ASCII-header, cursor blink, CRT на touch
6. Safety numbers UI страница (оба шелла)
7. TOFU warning при смене ключа (оба шелла)
8. Mobile touch pass (оба шелла)

### Открыто — приоритет 3 (Crypto/DR)
→ Sprint 5 в WORKPLAN.md

9. DR send path завершить (feature-flagged, не закончен)
10. Vault upgrade v1-v3 → v4 сценарный тест

### Открыто — приоритет 4 (Infra)
11. TURN/coturn runtime верификация

---

## Как Стартовать (exact order)

1. Прочитать этот файл + `AGENT_PROGRESS.md`.
2. Прогнать качество базы:
   ```
   npm run typecheck -w project-13-client
   npm run lint -w project-13-client
   npm run test -w project-13-server
   ```
3. Взять задачу из Sprint 10 (runtime) или Sprint 9 (UI) по приоритету.
4. При любых UI-правках: проверить **оба шелла** — MD3 и terminal.
5. Обновить `WORKPLAN.md` + `AGENT_PROGRESS.md` после каждого значимого шага.

---

## Important Notes

- Do not revert unrelated user changes.
- Если снова появится `[DECRYPT_FAIL]` — проверить, передаётся ли `drCtx` в конкретный decrypt-path.
- Не смешивать shell rules: MD3 и terminal токены изолированы по `[data-shell]`.
- Локальные HAR-трейсы после cleanup лежат в `/mnt/c/Users/rudywolf/Workspace/OneToThree/_local/diagnostics/har/` и не коммитятся.
