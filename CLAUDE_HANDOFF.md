# CLAUDE HANDOFF — START HERE

Last updated: 2026-04-22

## Goal

Continue work without speculative fixes. Reproduce first, then patch with tests.

## Source Of Truth

1. `WORKPLAN.md` — full backlog and sprint structure.
2. `AGENT_PROGRESS.md` — concise state snapshot + risks.
3. This file — immediate startup checklist for Claude.

## Immediate Open Tasks

1. Runtime bug: message is visible, then after re-entering chat becomes `[DECRYPT_FAIL]`.
2. MD3 bug: chat rows do not open chats reliably.
3. MD3 UX issue: left rail buttons are visually too large.

## How To Start (exact order)

1. Reproduce bugs from HAR traces:
   - `C:\Users\rudywolf\Downloads\Не отправляются сообщения.har`
   - `C:\Users\rudywolf\Downloads\md3.har`
2. Re-run local quality baseline:
   - `npm run typecheck -w project-13-client`
   - `npm run lint -w project-13-client`
   - `npm run test -w project-13-server`
3. Fix runtime decrypt regression first, then MD3 open-chat bug, then MD3 sizing polish.
4. Add/adjust regression tests for each fixed behavior.
5. Update `WORKPLAN.md` + `AGENT_PROGRESS.md` after each meaningful step.

## Important Notes

- Do not revert unrelated user changes.
- Prioritize runtime correctness over visual polish.
- If decrypt bug reappears, audit every feed rebuild path, not only realtime WS path.
- Keep cyberpunk theme behavior intact while tuning MD3-only visuals.
