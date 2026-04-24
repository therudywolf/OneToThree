# OneToThree Unfinished Work
Date: 2026-04-24
Status: open items after the current implementation and audit pass

## 1. Release blockers still open

- Real Android runtime validation is still missing:
  - cold install,
  - relaunch with restored session,
  - QR add-device approval,
  - TOTP path,
  - logout/login,
  - revoked device,
  - sticker cache hit after reopen,
  - GIF send/render,
  - 1:1 call over real mobile networks.
- 1:1 call fallback is now materially better, but it is not a full TURN/SFU replacement:
  - `client/src/hooks/use-webrtc.ts`
  - `client/src/lib/call-audio-relay.ts`
  - `server/src/routes/ws.ts`
  - hard NAT video/group scenarios still benefit from proper TURN/SFU.
- Theme/token debt remains the biggest visible frontend backlog:
  - `npm run audit:security` still reports `161` arbitrary-color violations,
  - main files: `client/src/app/admin/page.tsx`, `client/src/components/call/active-call-overlay.tsx`, `client/src/components/call/group-call-banner.tsx`, `client/src/components/call/incoming-call-modal.tsx`, `client/src/components/chat/composer-picker-panel.tsx`, `client/src/components/chat/create-group-modal.tsx`, `client/src/components/chat/message-actions.tsx`.

## 2. Security and reliability items still open

- `server/src/lib/totp-crypto.ts`
  - if `TOTP_WRAP_KEY` is absent, new TOTP secrets still fall back to plaintext storage.
  - This is configuration-sensitive and must be treated as a production hard requirement.
- `client/src/lib/fanout-crypto.ts`
  - partial per-device fan-out encryption failures still only log warnings;
  - UI does not yet surface `failedDeviceIds` or partial-delivery risk to the sender.
- `server/` dependency tree still has `12` non-dev advisories from `npm audit`:
  - `10 moderate`, `2 low`,
  - mostly in the `firebase-admin` / Google transport subtree:
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
- `client/` non-dev dependency audit is currently clean: `0` known vulnerabilities from `npm audit`.

## 3. UI / UX parity still open

- Telegram Desktop parity is better, but still incomplete across:
  - settings information architecture,
  - call overlays,
  - admin tables,
  - some picker and retro surfaces.
- Telegram iOS parity is still incomplete across:
  - mobile sheets/navigation depth,
  - keyboard choreography,
  - gestures and touch density,
  - message action ergonomics.
- The following areas still need live-browser revalidation even when static code looks improved:
  - `client/src/components/chat/chat-app.tsx`
  - `client/src/components/chat/chat-terminal.tsx`
  - `client/src/components/settings-modal.tsx`
  - `client/src/components/chat/composer-picker-panel.tsx`
  - `client/src/components/call/*`

## 4. Operations / deployment nuances

- `docker compose build web` cannot be used as an isolated web-only check unless required env vars for the whole compose graph are present.
  - In this audit environment it stops at compose interpolation because `JWT_SECRET` is missing.
- Direct Docker validation of `client/Dockerfile` was not completed here because Docker daemon access is unavailable in the current environment.
- The actual clean-build blocker reported by the user is fixed in code:
  - `client/src/lib/native-session.ts` no longer imports `@capacitor/core` at compile time.

## 5. Current verification state

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm run test:unit:client` — pass
- `npm run test:server` — pass
- `npm run build` — pass
- `npm run build:client:export` — pass
- `npm run audit:security` — fail, `161` violations

## 6. Recommended next execution order

1. Finish token/theme cleanup in the files leading `audit:security`.
2. Run real-device Android auth/media/call matrix.
3. Run real network validation for 1:1 encrypted audio relay.
4. Upgrade or pin the vulnerable `server` dependency subtree.
5. Decide whether `TOTP_WRAP_KEY` should become fail-closed in production boot instead of warn-and-fallback.
