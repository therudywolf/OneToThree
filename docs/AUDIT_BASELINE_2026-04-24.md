# OneToThree Audit Baseline
Date: 2026-04-24
Scope: UI, UX, security, performance, errors
Source of truth: current repo state, local static checks, existing runtime audit docs

## Check Snapshot

- `npm run typecheck`: `PASS`
- `npm run lint`: `PASS`
- `npm run build`: `PASS`
- `npm run build:client:export`: `PASS`
- `npm run test:unit:client`: `PASS`
  - `16` files, `77` tests green after safe persist storage for zustand stores and native-session coverage.
- `npm run test:server`: `PASS`
  - `26` files, `71` tests green after test DB bootstrap now auto-aligns missing compatibility columns and `/api/ice-servers` now has explicit stun-only coverage.
- `npm run audit:security`: `FAIL`
  - `161` violations, still dominated by retro/call/admin hardcoded colors and theme drift, but reduced further after picker/menu cleanup.

## Backlog

### UI

| Area | Status | Severity | Evidence | Owner |
|---|---|---:|---|---|
| Theme consistency across surfaces | reproduced | high | `audit:security` still reports 161 token/color violations; legacy `[data-theme]` CSS still overlaps runtime token applicator | client/ui |
| Retro theme completeness | partially fixed | high | shared retro visual kit now covers auth/device-link/forward flows, but calls, admin, picker, and message action surfaces still hardcode colors | client/ui |
| MD3 completeness | reproduced | high | runtime audit reports mixed terminal/md3 surfaces, especially settings/modals/pickers | client/ui |
| Settings navigation and visual hierarchy | reproduced | high | `docs/RUNTIME_UI_UX_AUDIT_2026-04-23.md` items 13, 17, 24, 25 | client/ui |
| Telegram Desktop / iOS parity | partially fixed | medium | desktop sidebar resize now uses pointer-based clamped drag with double-click collapse; mobile/modal surfaces improved in create-group and message actions, but full shell parity still incomplete | client/ui |
| Emoji UX consistency | already fixed | high | composer and dock now share one `emoji-picker-react` implementation instead of split custom-vs-library behavior | client/ui |

### UX

| Area | Status | Severity | Evidence | Owner |
|---|---|---:|---|---|
| Mobile auth entry hierarchy | partially fixed | high | Android-first entry hierarchy now leads with add-device and native session warming exists, but full live-device revalidation is still pending | client/auth |
| Desktop sidebar adaptability | already fixed | high | sidebar now clamps to viewport, preserves main pane width, and supports pointer resize like Telegram Desktop | client/chat |
| Search poisoning (`undefined`) | reproduced | high | prior runtime audit item 26/32; input sanitization exists in current sidebar code, but a fresh live-browser revalidation is still pending | client/chat |
| Destructive action safety | partially fixed | medium | message deletion now has explicit confirmation; broader destructive flows still need consistency audit | client/chat |
| Sticker settings/raw error UX | partially fixed | medium | settings panel now normalizes some failures, but broader sticker UX still incomplete | client/stickers |
| Push/noise in shell | reproduced | medium | prior runtime audit item 15 | client/push |

### Security

| Area | Status | Severity | Evidence | Owner |
|---|---|---:|---|---|
| TOTP secret at rest | reproduced | critical | `AUDIT.md` item C1; schema and crypto audit already identify plaintext risk | server/security |
| Step-up protection coverage | reproduced | high | `AUDIT.md` item H2/M5 | server/auth |
| SSRF redirect re-validation | reproduced | high | `AUDIT.md` item H5 | server/security |
| Route membership/authorization hardening gaps | reproduced | high | `AUDIT.md` item H4 and prior review notes | server/api |
| Privacy-safe push payload discipline | partially fixed | medium | `client/public/push-handler.js` improved; server payload contract still needs full enforcement verification | server/push |
| Calls without TURN | partially fixed | high | `/api/ice-servers` now falls back to STUN + `transportPolicy=all`; 1:1 calls now have encrypted audio relay fallback over existing `wss/https` signaling, but group/video still benefit from proper TURN/SFU | client/call + server/ws |

### Performance

| Area | Status | Severity | Evidence | Owner |
|---|---|---:|---|---|
| Sidebar virtualization | reproduced | high | listed in `AUDIT.md` H9; current sidebar still renders dense lists directly | client/chat |
| Listener/timer cleanup | reproduced | medium | audit items for online/devicechange/webrtc cleanup exist; not all retested in current run | client/runtime |
| Sticker/GIF/media warm-path caching | partially fixed | medium | IndexedDB sticker cache exists now, GIF favorites/search/send path is normalized, but live reopen/offline validation is still pending | client/media |
| Live runtime perf profile | blocked by env | medium | no fresh local two-account/browser runtime capture in this run | qa/perf |

### Errors / Reliability

| Area | Status | Severity | Evidence | Owner |
|---|---|---:|---|---|
| Client unit test truthfulness | already fixed | critical | persist-safe storage and updated tests make client unit CI green again | client/core |
| Server integration test truthfulness | already fixed | critical | compatibility bootstrap aligns test DB schema and keeps server integration CI green | server/core |
| Docker/web clean build blocker | already fixed | critical | `native-session` no longer imports `@capacitor/core` at compile time; clean Next web build path is restored | client/auth |
| GIF provider reliability | partially fixed | high | legacy public Giphy fallback removed and connect-src now allows provider media, but live send/render verification is still required | client/media |
| Phone login reliability | partially fixed | high | Android-first auth UI and native cookie/session bridge landed, but cold-install/relaunch/two-device runtime replay on a real device is still pending | client/auth + android |
| Group/channel creation stability | reproduced | high | runtime audit critical item 5 | client/chat + server/chat |

## Current Execution Notes

- This baseline intentionally separates `reproduced` from `stale audit`.
- Runtime browser revalidation is still required for:
  - desktop width behavior,
  - mobile overlay behavior,
  - two-account QR/device-link flows,
  - GIF send/render,
  - sticker cache hit after reopen,
  - 1:1 encrypted audio-relay call over Cloudflare / IP / direct origin.
- Release gate should only consider a finding closed after both:
  - code/static checks are green,
  - matching runtime scenario is replayed and recorded.
