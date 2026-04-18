# OneToThree Feature Matrix

Last updated: 2026-04-17

Legend:
- `implemented`: done and covered by checks
- `partial`: shipped but incomplete / uneven
- `broken`: present but unstable / incorrect behavior
- `stub`: placeholder logic, not product-complete
- `missing`: not implemented

## Stage Status

| Stage | Scope | Status | Notes |
|---|---|---|---|
| 0 | Audit + freeze + quality gates | implemented | Audit register and freeze list are tracked in `MASTER_AUDIT.md`; quality gates are scripted in `scripts/stage-all-suite.sh`. |
| 1 | Auth/Security foundation | partial | Auth/TOTP stabilized; server-side step-up is enforced for sensitive settings/device routes; full security architecture shift still in progress. |
| 2 | Device linking + recovery | partial | `link/init` + `link/confirm` exist; QR payload unified to `link_token`; recovery key setup/verify and explicit history-sync approval are implemented. |
| 3 | Messaging crypto/transport | partial | Legacy+fanout hybrid still present, one contract target not fully reached. |
| 4 | Calls/WebRTC | partial | P2P + TURN works; fallback matrix expanded (UDP/TCP/TLS), final ops hardening pending. |
| 5 | Notifications + PWA + mobile | partial | Push baseline exists; full unread/badge/open-on-tap parity still pending. |
| 6 | Groups/Channels/Moderation | partial | Core entities present; product-complete role/mod tooling and counters are incomplete. |
| 7 | Design system + settings architecture | partial | Theme token core and dynamic theme-color/color-scheme improved; full settings-domain normalization pending. |
| 8 | Missing features backlog | partial | Favorites baseline shipped; full polish/search/thread/media backlog remains. |
| 9 | Observability/docs/release | partial | Base docs/logging exist; release-grade checklists/regression coverage not complete. |

## Current Focus (UI-first)

Priority wave:
1. Stage 7 (theme system, layout discipline, settings domain cleanup)
2. Stage 5 (mobile/PWA consistency)
3. Stage 6 (product-complete groups/channels/moderation)

## Stage 7 delta in this change

- Added dynamic theme metadata model (`scheme`, `themeColor`) in theme store.
- Theme applicator now updates:
  - `data-theme`
  - runtime `color-scheme`
  - `<meta name="theme-color">`
- Root layout no longer hard-locks app to dark-only viewport metadata.
- Introduced additional semantic CSS tokens (`surface-elevated`, text/border/motion/radius tokens).
- Wired base component styles (`terminal-panel`, `terminal-input`) to semantic tokens.

## Stage 5 delta in this change

- Added retry policy for push critical operations (SW register/update, push subscribe, sync subscribe API, unsubscribe API, browser unsubscribe).
- Retry now avoids non-retryable failures (`WEB_PUSH_UNSUPPORTED`, `NOTIFICATION_DENIED`, invalid payload) and retries transient network/runtime errors with backoff.
- Added backward-compatible `username?: string` prop support in chat sidebar to prevent build regressions from stale callers during staged rollout.

## Stage 4/5 test delta in this change

- Added server route test coverage for TURN config generation and fallback matrix:
  - `server/src/routes/webrtc.test.ts`
- Added server route test coverage for push subscription lifecycle:
  - `server/src/routes/push.test.ts`
- Extended quality-gate suite to include these tests:
  - `scripts/stage-all-suite.sh`

## Stage 1/2 hardening delta in this change

- Added server-side TOTP step-up guard for sensitive user actions (device-management + device-linking toggle):
  - `server/src/lib/totp-stepup.ts`
  - integrated in `server/src/routes/users.ts`
- Added CORS allowance for `X-TOTP-Code` header:
  - `server/src/app.ts`
- Unified QR login payload to a single field:
  - `link_token` only across server/client/tests
- Added recovery key protocol (server-side hashed storage + verify endpoints):
  - `POST /api/auth/recovery/setup`
  - `POST /api/auth/recovery/verify`
- Added explicit history sync approval flow for linked devices:
  - `POST /api/users/me/devices/:deviceId/history-sync`
  - message/history APIs now enforce `future-only` until approval
