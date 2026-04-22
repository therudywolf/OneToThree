# AGENT_PROGRESS — OneToThree

Last updated: 2026-04-22b (bugfix session — production issues fixed)

## Snapshot For Next Agent

- Branch: `main`, working tree clean после bugfix-сессии.
- **КРИТИЧЕСКИЙ БАГ ЗАКРЫТ**: MD3 shell полностью скрывал ChatTerminal (`crt-terminal-vignette { display:none }` убивал root div).
- MinIO голосовые/видео починены (AWS SDK v3 checksum issue).
- Sidebar click area починен (pointer-events на hidden кнопках).
- Добавлено постоянное требование: **два независимых шелла (MD3 + Cyberpunk/Terminal), оба должны быть полностью отполированы**.
- **ПРАВИЛО**: перед написанием CSS для MD3 — проверять что CSS-класс не используется как container/root div в JSX.

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

## Лог (этот цикл)

| Коммит | Что |
|--------|-----|
| `50547ac` | mobile sidebar UX + DR decrypt consistency |
| `4b8…` | DR: OTP derivation + TOFU check + session functions |
| `2cd66ea` | feat: dual-shell identity modal + 5 i18n keys |
| `79217e7` | feat: Sprint 9 dual-shell — drawer/search/picker/call banner CSS |
| `36401a5` | feat: trust registry in settings + getTrustedPeerCount + 3 i18n keys |
| `90480a3` | feat: Terminal caret blink + scan-line bubble + MD3 composer ring |
