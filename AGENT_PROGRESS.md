# AGENT_PROGRESS — OneToThree

Last updated: 2026-04-22

## Mission Status

- Project is active; baseline branch is `main`.
- Stickers foundation is implemented end-to-end (import, picker, send, render).
- Critical bug backlog from user remains; this file is a handoff brief for any next agent.

## What Is Done

- Invite race condition fixed (atomic invite code write in chat invite route).
- Login flow re-uploads ECDH public key, reducing `DIRECT_FANOUT_UNAVAILABLE`.
- Recovery-key hashing fixed (`scrypt` explicit `maxmem`), server tests pass.
- Sidebar now has last-message preview and timestamp.
- Desktop top header is hidden (`md+`) to remove empty top gap above sidebar.
- Sidebar container now starts at the top edge (`top: 0`) and uses `100dvh`.
- Added a top `Chats` strip as the first sidebar-right-panel element (`sticky top-0`).
- Sidebar button-size normalization (phase 1.1) completed:
  - row action buttons normalized to fixed width targets
  - direct-open action/input and lower CTA buttons normalized to `h-10`.
- Button-size normalization (phase 1.2) completed:
  - `composer-picker-panel` tabs/import controls normalized to consistent heights
  - `chat-terminal` floating scroll button normalized.
- Sticker integration:
  - Server: `server/src/routes/stickers.ts`, wired in `server/src/app.ts`.
  - API: packs list/detail/items, Telegram import, `GET /api/stickers/asset-url`.
  - Client: `client/src/components/chat/composer-picker-panel.tsx`,
    `sticker-bubble.tsx`, `lib/api/stickers.ts`, `lib/sticker-payload.ts`.
  - Chat input/dock wiring uses unified composer slot (`emoji | sticker | gif`).
  - Message rendering supports sticker envelope previews and replies.
- Docs/progress:
  - `WORKPLAN.md` updated.
  - `CLAUDE.md` updated with vault v4, public chat plaintext note, schema updates.

## Verification Snapshot

- `npm run typecheck` (root): pass
- `npm run lint` (root): pass
- `npm run test -w project-13-server`: pass (68 tests)

## Current Open Priorities (User-Critical)

1. Invites still need full e2e validation in real client flow (`join/[code]`, status handling).
2. Messages pipeline still needs runtime validation with real accounts/devices:
   - direct fanout path
   - websocket delivery and decrypt
3. Saved Messages (self-chat) remains to verify/fix in production-like flow.
4. UI parity with Telegram Desktop is partial:
   - composer improved
   - many layout/interaction polish tasks remain in `WORKPLAN.md`
   - button-size unification is in progress (sidebar + composer done; dock/modal/mobile chips still to harmonize).
5. GIF provider integration (Tenor/Giphy) not started.
6. TGS/Lottie runtime renderer not integrated yet (currently fallback for tgs/lottie).
7. Double Ratchet send path is still incomplete (feature-flagged components exist).

## Recommended Next Execution Order

1. Sprint 1 runtime bugs (`invites`, `messages`, `saved`) with reproducible scenario.
2. Add/adjust tests for each fixed bug before moving to UI polish.
3. Implement GIF API integration.
4. Add TGS/Lottie renderer support with dependency + lazy loading.
5. Continue DR send-path milestones from `WORKPLAN.md`.

## Safety / Coordination Notes

- Do not rewrite existing user changes unrelated to current fix.
- Keep `WORKPLAN.md` and this file in sync after every meaningful fix.
- Before committing, always run at least:
  - `npm run typecheck`
  - `npm run lint`
  - relevant tests (`server` at minimum)
