# AGENT_PROGRESS — OneToThree

Last updated: 2026-04-22 (актуализация после Sprint 8 + dual-theme требование)

## Snapshot For Next Agent

- Branch: `main`, working tree dirty (ожидаемые локальные правки, не откатывать).
- Sprint 8 закрыт полностью (все acceptance criteria выполнены).
- Добавлено постоянное требование: **два независимых шелла (MD3 + Cyberpunk/Terminal), оба должны быть полностью отполированы**.

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

## Что Открыто (приоритет по убыванию)

### Приоритет 1 — Runtime E2E (Sprint 10)
- [ ] Invite flow runtime: `join/[code]`, group_e2e key propagation
- [ ] Direct fanout runtime: 2+ реальных устройства/аккаунта
- [ ] Saved Messages runtime: мульти-девайс

### Приоритет 2 — UI/UX (Sprint 9, оба шелла)
- [ ] MD3: message bubbles (align, timestamp, galki), hover actions, desktop header, micro-spacing
- [ ] MD3: mobile touch pass (drawer, composer, search)
- [ ] Cyberpunk: terminal bubbles, ASCII header, cursor blink, CRT на touch
- [ ] Safety numbers UI страница (оба шелла)
- [ ] TOFU warning (оба шелла)
- [ ] Sticker/GIF picker визуальная проверка в обоих шеллах

### Приоритет 3 — DR/Crypto (Sprint 5)
- [ ] DR send path завершить (`NEXT_PUBLIC_DR_ENABLED=1`)
- [ ] Vault upgrade v1-v3 → v4 сценарный тест
- [ ] TOFU warning реализация

### Приоритет 4 — Infra (Sprint 4)
- [ ] TURN/coturn runtime верификация

## Координационные Правила

- Не откатывать несвязанные изменения.
- `WORKPLAN.md` и этот файл синхронизировать после каждого значимого фикса.
- Если `[DECRYPT_FAIL]` снова появится — проверить, передаётся ли `drCtx` в конкретный decrypt-path.
- HAR-трейсы: `/mnt/c/Users/rudywolf/Workspace/OneToThree/Har/`.
- Качество базы перед крупными правками: typecheck + lint + test:server.

## Лог (этот цикл)

| Коммит | Что |
|--------|-----|
| `50547ac` | mobile sidebar close UX + DR decrypt consistency |
| `017fc32` | docs: MD3 overlap и theme-mix blockers в handoff |
| (локально) | Sprint 8 acceptance criteria выполнены |
| (локально) | WORKPLAN/AGENT_PROGRESS/CLAUDE_HANDOFF актуализированы, dual-theme требование зафиксировано |
