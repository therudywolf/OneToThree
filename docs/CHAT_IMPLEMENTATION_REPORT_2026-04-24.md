# OneToThree Chat Implementation Report
Date: 2026-04-24
Thread scope: full audit/fix cycle for UI, UX, auth, media, calls, tests, and baseline documentation

## 1. Intent

This thread moved the project from "audit-only planning" to a concrete implementation pass.
The main user requests were:

1. Fix desktop panel behavior and broken emoji UX.
2. Make calls work without requiring a dedicated TURN purchase or Cloudflare disablement.
3. Continue the remaining audit/fix plan and immediately correct visible UI/UX issues.
4. Leave a handoff artifact so the next model can continue without re-discovery.

## 2. High-Impact Changes Delivered

### 2.1 Test and CI truthfulness

- Stabilized zustand persistence in tests with safe storage fallback.
- Updated server test bootstrap to auto-align compatibility schema in test DB.
- Result:
  - client unit tests green
  - server tests green
  - typecheck/lint/build green

Primary files:

- `client/src/lib/safe-zustand-storage.ts`
- `client/src/store/unreadStore.ts`
- `server/src/test-setup.ts`

### 2.2 Mobile auth + Android session foundation

- Android/mobile login now prioritizes `Add device` instead of forcing weak web-first entry.
- Added native session bridge for WebView/Capacitor cookie sync so `fm_session` survives better in packaged Android runtime.
- Normalized login, device-link and auth QR error surfaces instead of leaking raw backend strings.

Primary files:

- `client/src/app/(auth)/login/page.tsx`
- `client/src/app/auth/qr/page.tsx`
- `client/src/components/login-form.tsx`
- `client/src/lib/api/auth.ts`
- `client/src/lib/api/auth-qr.ts`
- `client/src/lib/native-session.ts`
- `client/src/lib/native-session.test.ts`
- `client/src/lib/login-errors.ts`
- `client/src/lib/device-link-errors.ts`
- `mobile/capacitor/android/app/src/main/java/ru/onetothree/app/MainActivity.java`
- `mobile/capacitor/capacitor.config.json`

### 2.3 Theme architecture split

- Separated palette/shell/platform concerns:
  - `palette/theme`
  - `shellMode`
  - `platformProfile`
- Layout now respects `desktop-tg` vs `mobile-tg-ios` more explicitly instead of branching off raw theme ids.

Primary files:

- `client/src/store/themeStore.ts`
- `client/src/components/theme-applicator.tsx`
- `client/src/app/layout.tsx`
- `client/src/store/dockStore.ts`
- `client/src/store/themeStore.test.ts`

### 2.4 Sticker/GIF/media baseline

- Added persistent sticker cache in IndexedDB.
- Normalized sticker error UX.
- Removed legacy public Giphy fallback dependence and normalized degraded GIF mode.

Primary files:

- `client/src/lib/sticker-cache.ts`
- `client/src/lib/api/stickers.ts`
- `client/src/lib/sticker-errors.ts`
- `client/src/lib/api/gif.ts`
- `client/src/components/settings-stickers-panel.tsx`

### 2.5 Desktop sidebar + emoji UX

- Replaced split emoji implementations with one shared picker component.
- Composer and dock now use the same `emoji-picker-react` path.
- Sidebar resize now behaves more like Telegram Desktop:
  - pointer-based drag
  - viewport clamping
  - preserves main pane width
  - double-click collapse/expand
  - stronger resize affordance

Primary files:

- `client/src/components/chat/chat-emoji-picker.tsx`
- `client/src/components/chat/composer-picker-panel.tsx`
- `client/src/components/chat/dock-panel.tsx`
- `client/src/components/chat/chat-app.tsx`
- `client/src/app/globals.css`

### 2.6 Calls without mandatory TURN

This is the most important architectural change from this thread.

#### What changed

- `/api/ice-servers` no longer hard-fails when TURN is missing.
- Server now returns STUN-only fallback and `transportPolicy=all` when relay infra is absent.
- Client no longer treats `no TURN` as fatal by default.
- For 1:1 calls without TURN, the client now falls back to encrypted audio relay over the existing `wss/https` signaling path.

#### Why this matters

- Works through normal HTTPS/WebSocket routes.
- Survives Cloudflare-proxied signaling path.
- Does not require buying a separate TURN service.
- Does not require disabling Cloudflare just to get basic 1:1 voice working.

#### Current fallback behavior

- If TURN exists:
  - WebRTC uses relay-preferred behavior.
- If TURN does not exist:
  - `/api/ice-servers` returns STUN fallback.
  - 1:1 calls degrade to encrypted audio relay.
  - video/group calls still work best with proper TURN/SFU and are not fully guaranteed behind hard NAT.

#### Security model

- Relay audio frames are encrypted client-side with a shared AES key derived from existing ECDH identity keys.
- Server relays opaque frames through existing WebSocket signaling and cannot read media payloads.

Primary files:

- `server/src/routes/webrtc.ts`
- `server/src/routes/ws.ts`
- `server/src/routes/webrtc.test.ts`
- `client/src/lib/ice-servers.ts`
- `client/src/hooks/use-webrtc.ts`
- `client/src/lib/call-audio-relay.ts`
- `client/src/lib/crypto.ts`
- `client/src/store/callStore.ts`
- `client/src/locales/en.ts`
- `client/src/locales/ru.ts`

### 2.7 Repeated UI/UX cleanup beyond point 1

- Retrofitted multiple overlays and modals to shared visual/token behavior.
- Improved mobile/compact behavior in:
  - create-group modal
  - message actions menu
  - admin page tables/search/device modal
- Reduced security/theme audit further by removing remaining black/white hardcoded badges from picker flows.

Primary files:

- `client/src/components/chat/create-group-modal.tsx`
- `client/src/components/chat/message-actions.tsx`
- `client/src/app/admin/page.tsx`
- `client/src/components/vault-pin-gate.tsx`
- `client/src/components/post-register-vault-prompt.tsx`
- `client/src/components/settings-link-device-modal.tsx`
- `client/src/components/chat/forward-modal.tsx`
- `client/src/components/chat/media-preview-modal.tsx`
- `client/src/components/settings-devices-panel.tsx`
- `client/src/components/notification-mode-onboarding.tsx`
- `client/src/components/settings-modal.tsx`
- `client/src/lib/settings-errors.ts`

### 2.8 Post-deploy build and reliability follow-up

- Fixed the clean web build regression reported after update:
  - `client/src/lib/native-session.ts` no longer imports `@capacitor/core` at compile time,
  - native cookie bridge now resolves from runtime Capacitor globals instead.
- Fixed `online` listener lifecycle in the socket client:
  - `client/src/lib/api/socket.ts`
- Added explicit delete confirmations to message actions:
  - `client/src/components/chat/chat-terminal.tsx`
  - `client/src/locales/en.ts`
  - `client/src/locales/ru.ts`

## 3. Verification Snapshot

Verified during or at the end of the thread:

- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm run test:unit:client` — PASS (`16` files / `77` tests)
- `npm run test:server` — PASS (`26` files / `71` tests)
- `npm run build` — PASS
- `npm run build:client:export` — PASS
- `npm run audit:security` — FAIL, but improved to `161` violations
- `client` non-dev `npm audit` — `0` vulnerabilities
- `server` non-dev `npm audit` — `12` vulnerabilities (`10 moderate`, `2 low`)

Environment note:

- `docker compose build web` could not be used as an isolated validation in this audit environment because compose interpolation aborted on missing `JWT_SECRET`.
- Direct Docker rebuild verification was also blocked here because Docker daemon access is unavailable.

## 4. What Is Still Open

The project is materially better, but the original roadmap is still not fully exhausted.

Open items with the highest remaining leverage:

- Retro/MD3 token debt still exists in call surfaces and admin surfaces.
- Group/video calls behind hard symmetric NAT still benefit from real TURN/SFU and are not fully covered by the new 1:1 audio relay fallback.
- Real-device Android runtime still needs manual verification:
  - cold install
  - relaunch
  - add-device
  - cookie/session restoration
  - GIF send/render
  - sticker cache hit after reopen
  - 1:1 audio relay call through real network paths
- Full Telegram parity for settings/messages/calls is still incomplete.

## 5. Important Constraints / Notes For The Next Model

- Do not revert unrelated existing worktree changes; this tree is intentionally dirty.
- The browser-use plugin skill was checked, but in this session no callable browser inspection tool surfaced beyond normal developer tools, so most final audit work remained code-first rather than live-browser-first.
- The new call fallback is intentionally scoped to 1:1 encrypted audio relay. Do not oversell it as full SFU replacement.
- If continuing the theme cleanup, start with the files still leading `audit:security`:
  - `client/src/components/call/active-call-overlay.tsx`
  - `client/src/components/call/group-call-banner.tsx`
  - `client/src/components/call/incoming-call-modal.tsx`
  - `client/src/app/admin/page.tsx`
  - remaining retro branches in `client/src/components/chat/composer-picker-panel.tsx`

## 6. Canonical Audit Reference

Updated baseline lives here:

- `docs/AUDIT_BASELINE_2026-04-24.md`
