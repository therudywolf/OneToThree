# OneToThree Full Product Audit
Date: 2026-04-24
Scope: codebase-wide static audit + local verification of build, tests, security lint, dependency audit

## 1. Scope and coverage

Repository inventory checked in this pass:

- Total tracked project files reviewed at inventory level: `575`
- `client`: `299`
- `server`: `145`
- `mobile`: `57`
- `docs`: `23`

Key code clusters:

- `client/src/components`: `89`
- `client/src/lib`: `103`
- `client/src/hooks`: `33`
- `server/src/routes`: `31`
- `server/src/lib`: `50`
- `server/src/db`: `6`

This pass combined:

- static file inventory,
- targeted source review of auth, crypto, push, websocket, calls, stickers, settings, and chat surfaces,
- previous audit reconciliation,
- fresh local command verification.

## 2. Verification snapshot

- `npm run typecheck` — `PASS`
- `npm run lint` — `PASS`
- `npm run test:unit:client` — `PASS` (`16` files / `77` tests)
- `npm run test:server` — `PASS` (`26` files / `71` tests)
- `npm run build` — `PASS`
- `npm run build:client:export` — `PASS`
- `npm run audit:security` — `FAIL`, `161` arbitrary-color violations
- `client` non-dev `npm audit` — `0` known vulnerabilities
- `server` non-dev `npm audit` — `12` vulnerabilities (`10 moderate`, `2 low`)

Operational note:

- `docker compose build web` could not be used as a clean isolated validation here because compose interpolates required env vars for the whole stack and aborted on missing `JWT_SECRET`.
- Direct Docker build validation was also blocked in this environment because Docker daemon access is unavailable.

## 3. Confirmed fixed since earlier audits

The following older findings are no longer current based on code review and/or fresh verification:

- Web build blocker from `@capacitor/core` in `client/src/lib/native-session.ts`
  - fixed by removing compile-time package dependency and switching to runtime bridge detection.
- `client/public/push-handler.js`
  - `event.data.text()` fallback is now awaited correctly.
- `client/src/hooks/use-webrtc.ts`
  - stats polling interval cleanup exists on teardown.
- `client/src/components/settings-media-panel.tsx`
  - `devicechange` listener cleanup exists.
- `client/src/components/chat/chat-sidebar.tsx`
  - list virtualization now exists via `@tanstack/react-virtual`.
- `server/src/routes/link-preview.ts`
  - redirect-safe SSRF protection is implemented with per-hop validation and pinned fetch.
- `server/src/routes/auth.ts`
  - login `2FA` path now consumes TOTP codes and rejects replay.
- `server/src/lib/push.ts`
  - push payloads for normal messages are generic and no longer ship plaintext message previews.
- `client/src/lib/api/socket.ts`
  - online listener cleanup was fixed in this pass.
- `client/src/components/chat/chat-terminal.tsx`
  - delete actions now have explicit confirmation UX.

## 4. Current open findings

### Critical / high

- `server/src/lib/totp-crypto.ts`
  - TOTP secret encryption is implemented, but if `TOTP_WRAP_KEY` is missing the code still falls back to plaintext storage.
  - Risk class: production configuration weakness with direct 2FA compromise potential.
- `client/src/lib/fanout-crypto.ts`
  - partial per-device fan-out encryption failures still only warn in logs.
  - Result: sender can believe a direct message succeeded while one or more recipient devices remain undecryptable.
- `client/src/hooks/use-webrtc.ts`, `client/src/lib/call-audio-relay.ts`, `server/src/routes/ws.ts`
  - 1:1 encrypted audio relay fallback exists and improves survivability without TURN, but group/video hard NAT coverage is still incomplete.
  - Risk class: functionality/reliability, not cryptographic break.
- Real Android runtime is still unverified after the recent auth/session changes.
  - Risk class: release blocker for mobile confidence, especially around WebView cookie sync and QR/device-link approval.

### Medium

- `client/src/app/admin/page.tsx`
- `client/src/components/call/active-call-overlay.tsx`
- `client/src/components/call/group-call-banner.tsx`
- `client/src/components/call/incoming-call-modal.tsx`
- `client/src/components/chat/composer-picker-panel.tsx`
- `client/src/components/chat/create-group-modal.tsx`
- `client/src/components/chat/message-actions.tsx`
  - These files dominate the current `audit:security` output and still carry hardcoded colors / theme drift.
  - Risk class: UI inconsistency, poor theme completeness, maintainability drag.

- `server` dependency tree
  - `npm audit` reports `12` non-dev vulnerabilities:
    - `firebase-admin`
    - `@google-cloud/firestore`
    - `@google-cloud/storage`
    - `google-gax`
    - `gaxios`
    - `retry-request`
    - `teeny-request`
    - `uuid`
    - `fast-xml-parser`
    - `@aws-sdk/xml-builder`
    - plus low-severity transitive `http-proxy-agent` and `@tootallnate/once`
  - Risk class: dependency hygiene / future patch requirement.

### Medium / operational

- Compose build isolation is poor.
  - `docker compose build web` still depends on stack-wide env interpolation, so operators without a complete env set cannot isolate the frontend build path.
- `next export` warnings remain expected for this architecture.
  - rewrites/headers are ignored in static export mode,
  - this matters for Android/static-shell workflows and should remain documented.

## 5. UI / UX assessment

### Improved in this cycle

- Desktop sidebar resizing now behaves much closer to Telegram Desktop.
- Emoji picker path is unified instead of split and inconsistent.
- Several overlays/modals were normalized to shared theme behavior.
- Message deletion flow is safer due to explicit confirmation.

### Still visibly incomplete

- Telegram Desktop parity:
  - settings hierarchy,
  - call surfaces,
  - admin tables,
  - some dense header/action layouts.
- Telegram iOS parity:
  - sheet behavior,
  - gesture/touch ergonomics,
  - keyboard choreography,
  - compact mobile navigation flow.
- Theme completeness:
  - `cyberpunk` is closest,
  - `md3` still has mixed terminal bleed,
  - `retro` still has the largest token debt in complex surfaces.

## 6. Security assessment

Strong areas:

- cookie/session handling is conservative,
- SSRF protection for link preview is materially stronger,
- TOTP replay guard exists,
- push payloads are privacy-friendlier,
- JWT denylist checks are integrated into `verifySessionJwt`,
- auth QR/device-link flows have clearer structure and tests.

Weak areas still open:

- TOTP wrap key fallback behavior,
- dependency advisories in the server tree,
- missing runtime proof for Android/mobile auth after recent changes,
- incomplete sender-visible reporting for partial fan-out delivery failure.

## 7. Functional assessment

Strong areas:

- core build/test pipeline is green,
- server integration coverage is materially healthier,
- client unit harness is stable again,
- STUN-only + encrypted 1:1 audio relay gives a viable no-TURN fallback for basic voice.

Weak areas still open:

- full live verification of mobile auth/media/calls,
- theme completeness and responsive consistency,
- group/video call expectations without real TURN/SFU,
- several remaining UI surfaces still drift across shells.

## 8. Recommended next actions

1. Finish theme/token cleanup in the files leading `audit:security`.
2. Run real-device Android regression matrix end-to-end.
3. Run real network validation of 1:1 encrypted audio relay over multiple routes.
4. Upgrade or constrain the `server` dependency subtree flagged by `npm audit`.
5. Decide whether missing `TOTP_WRAP_KEY` should hard-fail in production instead of silently degrading.
