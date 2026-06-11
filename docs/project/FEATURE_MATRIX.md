# OneToThree Feature Matrix

Last updated: 2026-05-07

Legend:
- `implemented`: done and covered by checks
- `partial`: shipped but incomplete / uneven
- `broken`: present but unstable / incorrect behavior
- `stub`: placeholder logic, not product-complete
- `missing`: not implemented

## Feature Status

### Auth & Security

| Feature | Status | Notes |
|---|---|---|
| ECDSA P-256 challenge-response login | implemented | No passwords; private key never leaves vault |
| TOTP two-factor authentication | implemented | TOTP step-up enforced on sensitive routes |
| Device management (list, revoke) | implemented | Revoked devices gate all API access |
| QR device linking | implemented | `link/init` + `link/confirm`; unified `link_token` payload |
| Account recovery (phrase, no-escrow) | implemented | 24-word phrase; `POST /api/auth/recovery/challenge` + `/complete` (sign nonce vs phrase-derived pubkey), `/api/users/me/recovery/{enable,status,disable}`; server holds only ciphertext + a public key |
| History sync approval for linked devices | implemented | Explicit per-device approval, now gated by a recovery-phrase signature; future-only until approved |
| JWT denylist (logout/revocation) | implemented | Redis-backed |
| TOTP replay guard | implemented | Single-use codes via Redis |
| Rate limiting | implemented | Defined inline per route handler |

### Messaging

| Feature | Status | Notes |
|---|---|---|
| Direct (1:1) messages — fan-out ECDH | implemented | Per-device AES-GCM slots in `message_deliveries` |
| Self (Saved Messages) fan-out decrypt | implemented | Fixed 2026-04-21; routed through same per-device path as DIRECT |
| Group messages (SECTOR) | implemented | AES group key wrapped per member |
| Public chats | implemented | Plaintext base64; UI warns about no E2E |
| Message reactions | implemented | |
| Reply-to | implemented | |
| Pin messages | implemented | |
| Burn-after-read | implemented | `burn_at` timestamp |
| Read receipts | implemented | |
| Media messages (image/video/audio/file) | implemented | Client-side encrypted; MinIO presigned PUT |
| Message search | implemented | Local client-side only (IndexedDB index); server endpoint removed (410 Gone) |
| Failed send retry (IndexedDB outbox) | implemented | Background Sync API |
| Double Ratchet v2 (X3DH + DR) | implemented | Always-on (flag removed 2026-04-22); `use-send-message` → `encryptOutboundTextV2` → `encryptForPeer`; gated to single-device chats via `getDrFanoutSafety` |

### Groups & Channels

| Feature | Status | Notes |
|---|---|---|
| Group chats (SECTOR) | implemented | E2E group key wrapped per member; role management (kick, promote, transfer) in `group-chat-settings.tsx` |
| Channels (broadcast, Telegram-style) | implemented | DB + server routes complete; subscriber gating (read-only bar, `my_channel_role`); creation modal with channel tab; Megaphone header icon |
| Open groups / public discovery | implemented | `ExploreModal` + `discoverChats` API; FAB "Explore" button in sidebar |
| Closed groups | implemented | Invite-only join; admin/kick/promote UI in group settings |
| Member roles / moderation | implemented | `group-chat-settings.tsx`: kick, promote to admin/owner, transfer ownership, channel feed role; server PATCH/DELETE /chats/:id/members/:userId |

### Calls / WebRTC

| Feature | Status | Notes |
|---|---|---|
| P2P audio/video calls | implemented | Full mesh; UDP/TCP/TLS ICE fallback matrix |
| TURN relay (coturn) | implemented | Plain TURN always active; TURNS:5349 activates automatically after `sync-turn-certs.sh` |
| LiveKit SFU (3+ participants) | implemented | Token issuance + client integration; `joinGroupCall` tries SFU first, mesh fallback |
| Call E2EE via Insertable Streams | implemented | LiveKit `ExternalE2EEKeyProvider`; server derives HMAC-SHA256 room key per session (Redis TTL); client imports as AES-GCM CryptoKey and passes to Room e2ee options |

### Stickers

| Feature | Status | Notes |
|---|---|---|
| Sticker pack DB schema | implemented | Tables + routes fully wired; send/receive/clone/share pipeline complete |
| Telegram sticker import | implemented | Requires `TELEGRAM_BOT_TOKEN`; available in settings panel and composer picker |
| Sticker share links | implemented | `/stickers/add/[packId]` landing page; owner controls visibility via Globe toggle |
| Sticker picker UI | implemented | Picker in composer; pack management in Settings → Stickers |
| Lottie / TGS animation player | implemented | `sticker-preview.tsx` lazy-loads `lottie-web` + `pako`; TGS gunzip → Lottie JSON; plays in loop with autoplay |

### Notifications & PWA

| Feature | Status | Notes |
|---|---|---|
| Web Push baseline | implemented | VAPID keys; subscription lifecycle; retry policy |
| Unread counts / badge | partial | Push delivered; open-on-tap and badge parity incomplete |
| PWA install / offline | partial | Service worker registered; background sync for outbox |

### Design System

| Feature | Status | Notes |
|---|---|---|
| Cyberpunk2077 palette + Terminal shell | implemented | Fully square (0px radius); CRT overlay; neon tokens |
| Material Design 3 shell | implemented | M3 motion timings, elevation scale, typography tokens |
| Dynamic theme-color meta | implemented | `<meta name="theme-color">` updated on palette change |
| Reduced motion support | implemented | 0ms timings when `motionMode === 'reduced'` |

### Infrastructure

| Feature | Status | Notes |
|---|---|---|
| Docker Compose production stack | implemented | Caddy + Next.js + Fastify + Postgres + Redis + MinIO + coturn + LiveKit |
| Auto-TLS (Let's Encrypt via Caddy) | implemented | |
| Docker secrets | implemented | `/run/secrets/*`; never in env files at runtime |
| DB migrations (Drizzle) | implemented | Run via `db-migrate` container on startup |
| CI: lint + typecheck + test + audit | implemented | GitHub Actions `prod-checks.yml` |
| CI: Trivy security scan | implemented | `@0.35.0`; CRITICAL/HIGH fails build |
