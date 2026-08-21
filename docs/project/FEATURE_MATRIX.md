# OneToThree Feature Matrix

Last updated: 2026-08-14

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
| Device linking by typed code | implemented | `link/rendezvous` with `want_code` + `link/rendezvous/resolve-code`. For the case a QR cannot serve at all — a desktop linked from another desktop, where neither has a camera. 8 Crockford-base32 characters, five minutes, resolvable only by an authenticated session, and gated behind the same verification-code comparison as Mode B |
| Account recovery (phrase, no-escrow) | implemented | 24-word phrase; `POST /api/auth/recovery/challenge` + `/complete` (sign nonce vs phrase-derived pubkey), `/api/users/me/recovery/{enable,status,disable}`; server holds only ciphertext + a public key |
| Future-only history for new linked devices | implemented | A newly-linked device is served only post-link messages by the server (`messages.ts`); the chat backlog is never handed to it |
| JWT denylist (logout/revocation) | implemented | Redis-backed |
| TOTP replay guard | implemented | Single-use codes via Redis |
| Rate limiting | implemented | App-wide limiter in `app.ts` (100/min, Redis-backed so counters survive a deploy and two replicas share them), keyed `user:<id>` for authenticated traffic and `ip:<addr>` otherwise; routes tighten it via `config.rateLimit`. Fails **open** on a store error — it is abuse control, not an authorization boundary |
| Closable self-registration | implemented | `FEATURE_OPEN_REGISTRATION` (default on); off makes guest links the only door for strangers |

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
| Channels (broadcast, Telegram-style) | implemented | Posting fixed 2026-08-13 — the missing `channel` branch in `buildChatCryptoContext` had left the composer disabled for EVERYONE including the owner while this row already said "implemented". Subscriber gating (`channel_role`, server-enforced), `PATCH .../channel-role`, discussion link, megaphone + subscriber count in the list. Live coverage: `ONLY=channel` in `scripts/e2e-live/run.mjs` |
| Channel metadata & publicity | implemented | Migration 0063: `chats.description` / `avatar_key` / `is_public`. Owner-only `PATCH /chats/:id` (rename — the name used to be write-once), avatar upload (`/chats/:id/avatar/{presign,commit}`, owner-only, 10/hour, server-issued key only), catalog switch (unlisted stays joinable by link). Rendered where a channel is actually met — chat list, chat header, discovery catalog, profile card — with a megaphone and a subscriber count instead of a group's "N участников"; `chat-folders` no longer files open groups under "Каналы" |
| Personal channel on the profile | implemented | `users.profile_channel_id` (migration 0061, FK → chats, SET NULL). Owner-validated in `PATCH /users/me`; profile serves a channel card with a join handle; picker in Настройки → Профиль |
| Open groups / public discovery | implemented | `ExploreModal` + `discoverChats`, filtered by `is_public`. Entry point sits with the peer search, not under "Создать" — browsing is finding, not creating |
| Closed groups | implemented | Invite-only join; admin/kick/promote UI in group settings |
| Member roles / moderation | implemented | `group-chat-settings.tsx`: kick, promote to admin/owner, transfer ownership, channel feed role; server PATCH/DELETE /chats/:id/members/:userId |

### Calls / WebRTC

| Feature | Status | Notes |
|---|---|---|
| P2P audio/video calls | implemented | Full mesh; UDP/TCP/TLS ICE fallback matrix |
| TURN relay (coturn) | implemented | Plain TURN always active; TURNS:5349 activates automatically after `sync-turn-certs.sh` |
| LiveKit SFU (3+ participants) | implemented | Token issuance + client integration; `joinGroupCall` tries SFU first, mesh fallback |
| Guest links — meeting guests (no account) | implemented | Opt-in `FEATURE_GUESTS`; knock → host approves → LiveKit token with `name`/`metadata`; seats (`max_uses`), kick via RoomService + identity denylist; no `users` row is ever created. Badged on the call tile and in the participants panel of both `/meet/[room]` and the in-app group call, from the token's `metadata` claim — server-set, so a participant cannot self-declare or shed the badge by renaming |
| Guest links — temporary chat | implemented | Ephemeral `users` row (`user_group='guest'`), keys live in the tab's sessionStorage; deny-by-default route allowlist; `POST /users/lookup` returns `user_group` so the chat header badges the peer; purged on leave / host kick / offline grace / TTL — account and conversation go together |
| Call E2EE via Insertable Streams | implemented | LiveKit `ExternalE2EEKeyProvider`; server derives HMAC-SHA256 room key per session (Redis TTL); client imports as AES-GCM CryptoKey and passes to Room e2ee options |
| Camera background blur / replacement | implemented | MediaPipe selfie segmentation on a Worker + OffscreenCanvas pipeline, driven by the capture stream rather than main-thread timers (a backgrounded tab kept ~1fps under timer throttling); DOM pipeline is the non-Chromium fallback. Assets self-hosted — needs `'wasm-unsafe-eval'` in the CSP and `.wasm`/`.tflite` in `proxy.ts` STATIC_ASSETS_RE, or the effect silently never starts |
| Microphone processing (gate + RNNoise) | implemented | AudioWorklet noise gate, optional RNNoise ML denoise (self-hosted wasm+worklet); "hear yourself" loopback in Settings runs the real chain. Published on the LiveKit path too, not just mesh |
| Simultaneous camera + screen share | implemented | Screen rides its own senders under a dedicated msid (`screen_share` / `group_call:screen_share` signal); separate `peer#screen` tile, local own-screen preview, camera independent during a share. 1:1 and mesh groups |
| Screen share quality | implemented | Resolution × frame rate up to 4K/120, encoder budgets on the sender (`maxBitrate` + `degradationPreference`); stereo tab/system audio via Opus fmtp munge, with a share-audio mute |
| Call timeline events | implemented | Completed calls log a `system:v1` `call_ended` message with talk duration — exactly one per call regardless of who hangs up first; previously only missed calls appeared |

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
| Native Android push (FCM) | partial | Code is complete, credentials are not in the repo: the APK needs a per-project `google-services.json` (gitignored) and the server needs `FIREBASE_SERVICE_ACCOUNT_JSON`. A build without them succeeds and simply never delivers a notification — now a loud build-time warning, and both halves are documented in `docs/guides/android-release-runbook.md` + `server/.env.example` |
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
