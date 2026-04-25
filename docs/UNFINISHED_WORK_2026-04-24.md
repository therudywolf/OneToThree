# OneToThree Unfinished Work
Date: 2026-04-25
Status: open items after the current implementation and audit pass

## 1. Release blockers still open

- Real Android runtime validation is still missing:
  - debug APK is now built successfully at `mobile/capacitor/android/app/build/outputs/apk/debug/app-debug.apk`,
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
- Theme/token debt is no longer a release blocker:
  - `npm run audit:security` now reports `0` violations,
  - remaining frontend backlog is parity polish, responsive behavior, and live runtime verification.

## 2. Security and reliability items still open

- `client/src/lib/fanout-crypto.ts`
  - sender-visible warnings now exist for partial per-device fan-out delivery failures,
  - but the UI still does not offer an active recovery flow beyond the warning toast.
- `server/` dependency tree still has `10` non-dev advisories from `npm audit`:
  - `8 moderate`, `2 low`,
  - mostly in the `firebase-admin` / Google transport subtree:
    - `firebase-admin`
    - `@google-cloud/firestore`
    - `@google-cloud/storage`
    - `google-gax`
    - `gaxios`
    - `retry-request`
    - `teeny-request`
    - `uuid`
- `client/` non-dev dependency audit is currently clean: `0` known vulnerabilities from `npm audit`.
- `server/src/lib/totp-crypto.ts`
  - new production boot now hard-fails without `TOTP_WRAP_KEY`,
  - remaining work is operational: review and migrate any legacy plaintext TOTP rows created before this change.

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
- `npm run android:build:debug` — pass
- `npm run audit:security` — pass, `0` violations

## 6. Recommended next execution order

1. Run real-device Android auth/media/call matrix.
2. Run real network validation for 1:1 encrypted audio relay.
3. Upgrade or pin the vulnerable `server` dependency subtree.
4. Review and migrate any legacy plaintext TOTP rows created before the new fail-closed rule.
5. Continue Telegram Desktop / iOS parity polish on calls, settings, and mobile gestures.
