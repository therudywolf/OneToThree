# AGENT_PROGRESS — OneToThree

Last updated: 2026-04-22e (relay-only calls update)

## Snapshot For Next Agent

- Branch: `main`, working tree clean после bugfix-сессии.
- **КРИТИЧЕСКИЙ БАГ ЗАКРЫТ**: MD3 shell полностью скрывал ChatTerminal (`crt-terminal-vignette { display:none }` убивал root div).
- MinIO голосовые/видео починены (AWS SDK v3 checksum issue).
- Sidebar click area починен (pointer-events на hidden кнопках).
- Добавлено постоянное требование: **два независимых шелла (MD3 + Cyberpunk/Terminal), оба должны быть полностью отполированы**.
- **ПРАВИЛО**: перед написанием CSS для MD3 — проверять что CSS-класс не используется как container/root div в JSX.

## Incident Notes (2026-04-22d)

- [x] **DB migration incident fixed**: `start.sh update` падал на `0035_same_molly_hayes.sql` с `channel_role already exists`.
  - Fix shipped to `main`: commit `03611fe`.
  - Result: `db-migrate` now completes successfully on update.
- [ ] **Media upload still blocked in production**: `STORAGE_PUT_403 SignatureDoesNotMatch`.
  - HAR confirmed: `Har/gs.har`, `Har/gol.har`.
  - Root cause: presigned PUT signs `content-length` (`X-Amz-SignedHeaders=content-length;host`) and proxy path breaks signature.
  - Prepared local fix (not yet shipped): remove `ContentLength` from presign path in:
    - `server/src/lib/s3.ts`
    - `server/src/routes/storage.ts`
- [ ] **Message disappears after reopening chat** (empty/`[DECRYPT_FAIL]` regression window).
  - Prepared local fix (not yet shipped): history-load fallback from local cache by `message.id` in:
    - `client/src/hooks/use-load-chat-messages.ts`

## Relay-only Calls Update (2026-04-22e)

- [x] **No-fallback call policy shipped in code**:
  - server: `server/src/routes/webrtc.ts`
  - client ICE resolver: `client/src/lib/ice-servers.ts`
  - client call runtime: `client/src/hooks/use-webrtc.ts`
- [x] Поведение теперь строгое:
  - нет public STUN fallback;
  - нет auto fallback path при `ICE failed/timeout`;
  - при отсутствии TURN конфигурации сервер возвращает `503 TURN_NOT_CONFIGURED`.
- [x] Проверки:
  - `npm run typecheck -w project-13-client` PASS
  - `npm run lint -w project-13-client` PASS
  - `npx vitest run src/routes/webrtc.test.ts` PASS
- [!] Полный `npm run test -w project-13-server` сейчас красный из-за отдельной старой проблемы test DB schema (`messages.seq` отсутствует), не из этого change-set.

## Что НЕ закрыто в этом заходе

- [ ] `STORAGE_PUT_403` media upload hotfix не дошиплен (`server/src/lib/s3.ts`, `server/src/routes/storage.ts`).
- [ ] Reopen-chat `[DECRYPT_FAIL]` hotfix из `use-load-chat-messages.ts` не дошиплен.
- [ ] Runtime E2E (invite/direct fanout/saved messages), DR send path — без изменений.

## Возможные риски после policy change

- [!] Если TURN/Cloudflare TURN/coturn временно недоступен, звонки не работают вообще (ожидаемое поведение по новой политике).
- [!] Возможны регрессии UX: на слабой сети не будет "мягкого" fallback-пути, только fail.
- [ ] Нужен runtime smoke в реальном окружении за Cloudflare/Caddy после deploy.

## Verified In This Cycle (Sprint 8)

- `npm run typecheck -w project-13-client` → PASS
- `npm run lint -w project-13-client` → PASS
- `npm run test -w project-13-server` → PASS (68/68)

## Dual-Theme Requirement (ПОСТОЯННОЕ)

Проект имеет **два полностью независимых UI-шелла**:

| Шелл | `data-shell` | Стиль |
|------|-------------|-------|
| MD3 | `"md3"` | Material Design 3: Google Sans, скруглённые, dynamic colors |
| Cyberpunk/Terminal | `"terminal"` | monospace, neon, CRT/glitch, ASCII |

**Правила изоляции:**
- `[data-shell="md3"]` — компонентные стили MD3.
- `[data-shell="terminal"]` — компонентные стили Cyberpunk.
- `[data-theme="*"]` — только palette-токены (цвета), никаких компонентных правил.
- Каждый UI-коммит проверяется в обоих шеллах.

## Что Закрыто (Sprint 8)

1. **[DECRYPT_FAIL] root fix** — `directPeerUserId` вычисляется синхронно из `chats + activeChatId`, `drCtx` доступен немедленно при смене чата. Файл: `chat-app.tsx`.
2. **MD3 чаты не открывались** — та же причина (drCtx=null → DECRYPT_FAIL → пустой chat).
3. **MD3 left rail buttons** — `h-8 w-8 rounded-full`, иконки 18px. Файл: `chat-sidebar.tsx`.
4. **Sidebar action overlap** — CSS `:first-child` fix. Файл: `globals.css`.
5. **Theme isolation** — убраны все компонентные правила из `[data-theme="md3dark/light"]`. Файл: `globals.css`.

## Что Закрыто в этом цикле

### Sprint 5 — DR stability ✅
- OTP deterministic derivation (`deriveOtpPrivKey` + `deriveOtpBatch`)
- OTP publish on unlock + replenish threshold in `vault-modal.tsx`
- `acceptIncomingInit` reconstructs OTP keypair from deriver
- TOFU check in `bootstrapSession` → throws `TOFU_IDENTITY_CHANGED`
- `encryptForPeer` re-throws TOFU error; `explainSendError` surfaces it
- `getSessionPeerIdentity` + `clearDrSession` added

### Sprint 4 — TURN/coturn ✅
- 68/68 server tests pass including 6 webrtc/TURN tests
- coturn HMAC credential generation verified (`ICE_CONFIG_GENERATED :: COTURN_SELF_HOSTED`)
- ICE server client (`ice-servers.ts`) fully correct: cache, normalize, fallback

### Sprint 9 — Dual-shell UI parity ✅
- **9.1 MD3**: identity-modal MD3 variant (rounded-[28px], tonal buttons, emerald trust)
- **9.1 MD3**: desktop chat header (`p13-desktop-chat-header`) shell-aware
- **9.1 MD3**: hover quick-actions (`p13-hover-actions`) MD3 pill variant
- **9.2 Cyberpunk**: animated caret blink, scan-line bubble accent on outgoing msgs
- **9.2 Cyberpunk**: terminal neon gradient on desktop header ::after
- **9.3 Cross**: Trust registry section in Security settings (both shells)
- **9.3 Cross**: TOFU change alert + reset in identity modal (both shells)
- **9.3 Cross**: p13-search-overlay, p13-picker-panel, p13-group-call-banner CSS classes
- **9.3 Cross**: Mobile sidebar drawer shell-aware (MD3 rounded+shadow, Terminal neon border)
- **i18n**: 8 new keys in en+ru (identity.title, .fingerprint, .drSafetyNumber, .tofuChanged, .acceptNewKey, settings.trustRegistry, .trustRegistryHint, .trustRegistryCount)

## Что Открыто (приоритет по убыванию)

### Приоритет 1 — Runtime E2E (Sprint 10)
- [ ] Invite flow runtime: `join/[code]`, group_e2e key propagation
- [ ] Direct fanout runtime: 2+ реальных устройства/аккаунта
- [ ] Saved Messages runtime: мульти-девайс
- [ ] DR send path (`NEXT_PUBLIC_DR_ENABLED=1`) — end-to-end runtime test

### Приоритет 2 — Remaining UI polish
- [ ] Group call screen visual check in both shells
- [ ] Vault modal group settings modal full visual audit both shells

## Координационные Правила

- Не откатывать несвязанные изменения.
- `WORKPLAN.md` и этот файл синхронизировать после каждого значимого фикса.
- Если `[DECRYPT_FAIL]` снова появится — проверить, передаётся ли `drCtx` в конкретный decrypt-path.
- HAR-трейсы: `/mnt/c/Users/rudywolf/Workspace/OneToThree/Har/`.
- Качество базы перед крупными правками: typecheck + lint + test:server.

## Лог (bugfix сессия 2026-04-22b)

| Коммит | Что |
|--------|-----|
| `e1ffe14` | **MD3 ChatTerminal hidden fix** — `crt-terminal-vignette { display:none }` → только `box-shadow:none` |
| `7934fee` | MinIO S3 403 fix + sidebar pointer-events + emoji CSS vars + DECRYPT_FAIL cache + TOFU normalize |
| `f15bffe` | .gitignore: Har/ Screen/ в исключения |

## Открытые проблемы после bugfix

- **DECRYPT_FAIL на старых сообщениях** — ECDH ключ сменился (пересоздание vault/другое устройство). Исторические сообщения необратимы без оригинального ключа. Нужен UI для информирования пользователя.
- **Sidebar hover-иконки** занимают 120px (3×w-10) постоянно в DOM — текст усекается. Нужно `width:0 overflow-hidden group-hover:width-10` или `position:absolute`.

## UI/UX Quick Fixes (этот цикл, без крипты/сложного runtime)

- Починен контекст-меню чата: теперь меню **зажимается в границы viewport** и не уходит за край экрана.
- Увеличена минимальная ширина меню (`220px`) + добавлен `max-width` от ширины окна.
- Тексты пунктов меню больше не режутся: добавлен перенос строк (`whitespace-normal`, `break-words`).
- Починен UX `sidebar hover`-иконок: экшены `pin/favorite/mute` теперь скрыты в `w-0` до hover/focus и **не резервируют 120px** в строке чата.
- Исправления сделаны только в UI-компонентах `client/src/components/chat/chat-row-context-menu.tsx` и `client/src/components/chat/chat-sidebar.tsx`.
- Для мобильного/тач UX: action-зона строки чата теперь также видна у **активного** чата без hover.
- Мелкая полировка строки чата: timestamp получил `tabular-nums + truncate`, unread badge выровнен фиксированной min-width.
- Узкие экраны: в `chat row` имя теперь имеет приоритет (`min-w-0 flex-1 truncate`), а timestamp скрывается на `<sm`, чтобы не конфликтовать с бейджами/иконками.
- Calls touch UX: верхний статус-бар `PeerTile` теперь всегда видим на mobile/touch (не только через hover), чтобы fullscreen control был доступен без мыши.
- Admin UX на mobile: обе таблицы получили `overflow-x-auto` + `min-width`, а action-кнопки в строках всегда видимы на мобильных (без зависимости от hover).
- Onboarding parity: `StartGuide` получил shell-aware стили для `md3` (типографика, кнопки, surface/elevation), terminal стиль сохранён отдельно.
- Group call mobile polish: control bar стал edge-safe на узких экранах (left/right inset), иконки получили единый touch-first размер и `aria-label`.
- Settings mobile polish: tab-strip в `settings-modal` переведён в горизонтальный scroll, tab-кнопки получили `min-h-11` и `whitespace-nowrap` для стабильных hit-target.
- Валидация после батча: `npm run typecheck -w project-13-client` и `npm run lint -w project-13-client` — PASS.
- **Сознательно не трогали** крипту, DR, invite runtime, fanout и другие сложные задачи (оставлено следующей нейросети).

## Лог (этот цикл)

| Коммит | Что |
|--------|-----|
| `50547ac` | mobile sidebar UX + DR decrypt consistency |
| `4b8…` | DR: OTP derivation + TOFU check + session functions |
| `2cd66ea` | feat: dual-shell identity modal + 5 i18n keys |
| `79217e7` | feat: Sprint 9 dual-shell — drawer/search/picker/call banner CSS |
| `36401a5` | feat: trust registry in settings + getTrustedPeerCount + 3 i18n keys |
| `90480a3` | feat: Terminal caret blink + scan-line bubble + MD3 composer ring |
