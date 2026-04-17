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
| 0 | Audit + freeze + quality gates | partial | Typecheck/tests/smoke exist; unified `MASTER_AUDIT.md` and full freeze registry still missing. |
| 1 | Auth/Security foundation | partial | Auth/TOTP stabilized; full security architecture shift still in progress. |
| 2 | Device linking + recovery | partial | `link/init` + `link/confirm` exist; production UI still has QR session path and recovery is not final. |
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
