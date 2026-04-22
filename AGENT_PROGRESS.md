# AGENT_PROGRESS — OneToThree

Last updated: 2026-04-22 (post mobile+DR hotfix audit)

## Snapshot For Next Agent

- Branch: `main`, working tree dirty (expected local edits, no revert needed).
- User-critical recent fixes landed locally:
  - mobile sidebar got explicit close UX on phone (`X` button in drawer header),
  - left rail got bottom utility actions (settings / notifications / vault lock),
  - disappearing-message regression fixed by passing DR context in history/deferred sync decrypt paths.

## Verified In This Cycle

- Client static quality:
  - `npm run typecheck -w project-13-client` → PASS
  - `npm run lint -w project-13-client` → PASS
- Server stability:
  - `npm run test -w project-13-server` → PASS (full suite green).
- HAR-based root cause confirmed for message vanish:
  - outbound rows carry `protocol_version=2`, `device_iv="dr:v2"`, `dr_header`,
  - before fix, history/sync decrypt path lacked `drCtx`, producing `[DECRYPT_FAIL]`.

## What Changed Right Now (Important)

1. Mobile UI/UX:
   - Added visible close affordance for chat-list drawer on phones.
   - File: `client/src/components/chat/chat-app.tsx`.
2. Sidebar utility UX:
   - Added bottom buttons on left rail: Settings, Notifications toggle, Vault lock.
   - Files: `client/src/components/chat/chat-sidebar.tsx`, `client/src/components/chat/chat-app.tsx`.
3. DR decrypt consistency:
   - `drCtx` now propagated to history load and pending-delivery sync hooks.
   - Files:
     - `client/src/hooks/use-load-chat-messages.ts`
     - `client/src/hooks/use-message-delivery-sync.ts`
     - `client/src/hooks/use-messages.ts`

## Остатки / Fragments For Next Agent

### A) Runtime (highest priority)

- Invites e2e (client flow still not fully runtime-validated):
  - `join/[code]` states, wrong/expired code UX, `group_e2e` key propagation.
- Saved Messages self-flow runtime verification still pending (multi-device included).
- Direct fanout runtime validation still needed with at least 2 real devices/accounts.

### B) DR / Crypto

- DR send path still partially feature-flagged and not fully completed server/client end-to-end.
- TOFU/identity-change warning UX still not implemented.
- Vault upgrade path v1-v3 → v4 needs explicit migration scenario test.

### C) UI/UX parity

- Baseline sizing pass is largely complete, but Telegram-like parity is still partial:
  - micro-spacing consistency,
  - desktop chat header details,
  - hover actions and interaction polish.
- Mobile now has close button for drawer, but still worth usability pass with real touch testing.

### D) Calls/TURN

- Needs real environment verification (`/api/ice-servers`, coturn/HMAC credentials, fallback behavior).

## Concrete Next Steps (exact order)

1. Reproduce 3 user flows in real runtime:
   - invite join,
   - direct message send/receive across two devices,
   - saved messages send/reload.
2. Add/adjust regression tests per reproduced bug.
3. Finish DR send-path milestones from `WORKPLAN.md`.
4. Perform focused mobile UX smoke pass (drawer, composer, search overlay).
5. Re-run:
   - `npm run typecheck -w project-13-client`
   - `npm run lint -w project-13-client`
   - `npm run test -w project-13-server`

## Coordination Rules

- Do not discard unrelated local changes.
- Keep `WORKPLAN.md` and this file synchronized after every meaningful fix.
- If `[DECRYPT_FAIL]` reappears, inspect whether decrypt path includes `drCtx` for that code path.

## User Directive For Next Agent (Claude)

- Stop further "quick fixes" without full runtime reproduction.
- Treat the following as open tasks for Claude:
  1. Messages show, then become `[DECRYPT_FAIL]` after re-entering chat.
  2. MD3 theme: chats are not opening reliably.
  3. MD3 theme: left rail buttons look oversized/disproportionate.
- Priority order: runtime correctness first, then MD3 UX sizing/polish.
