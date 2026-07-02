# Changelog

All notable changes to OneToThree are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

## [0.9.1] — 2026-07-03 — Media delivery fix (DIRECT chats)

### Fixed
- **Media in DIRECT chats was undecryptable for recipients.** Attachments
  (image/voice/video/file + albums) were encrypted with the legacy v1
  `encryptOutboundText` path, so they went out as `protocol_version=1`
  per-device fan-out. DIRECT is strictly Double-Ratchet v2 on receive, which
  rejects v1 (`ERR_DIRECT_V1_REJECTED`) — every media message in a direct chat
  showed as "message could not be decrypted" on the other side. Media now uses
  the same DR-v2 path as text (`encryptOutboundTextV2` → `dr_slots`).
  SECTOR/PUBLIC keep the legacy single-key path; SELF is unchanged.
- **Second attachment dropped mid-upload.** Attaching a file while a previous
  one was still uploading dropped the new file: the post-upload queue drain used
  a positional `slice(1)` that removed whichever file was now at index 0 (the
  freshly attached one). Removal is now by identity.
- **Decrypt result could regress to a failure placeholder.** On a cold chat
  open, concurrent receiver paths (history load, realtime backlog, delivery
  sync) each ratchet-decrypt the same rows; the loser re-derives a consumed
  one-time key and yields `[DECRYPT_FAIL]`, which a blind `setMessages` replace
  could write over an already-good plaintext. Plaintext is now monotonic in the
  chat store (a decrypted message never regresses; failed placeholders upgrade
  to a clean decrypt). `[KEY_CHANGE_DETECTED]` still surfaces.

### Tests
- Repaired the media e2e specs (they never reached the receiver assertions, so
  they masked the bug above): decodable 16×16 PNG fixture, locale-independent
  `data-testid="media-preview-caption"`, race-safe send click, and a
  toast-based oversized-rejection assertion.

## [0.9.0] — 2026-07-02 — Hardening, device-link, media lifecycle & bug hunt

### Security & bug-hunt fixes (2026-06/07)
- **WS resilience**: connect/disconnect chains no longer turn a transient
  DB/Redis error into an unhandledRejection that shut the whole server down;
  `maxPayload` capped so oversized frames can't buffer ~100 MiB; the block check
  on high-frequency group-call relay frames is cached (per-connection TTL).
- **Double Ratchet**: `loadSession` fails closed on an unreadable-but-present
  session record, so a re-bootstrap can't silently adopt a server-supplied peer
  identity (TOFU / identity-change bypass).
- **Device linking**: rendezvous `/deposit` now requires a dedicated
  `deposit_secret` — a leaked (path-visible) rendezvous id can no longer inject a
  vault-handoff blob. Android gains a **Keystore vault-PIN bridge** (silent
  unlock, no PIN re-entry).
- **Authz/privacy**: `GET /users/:id/devices` is gated to self or a shared chat
  (no cross-user device enumeration); device-list queries are bounded.
- **Chat**: SELF (Saved Messages) edits propagate across your own devices; a
  stale fan-out pending-pull no longer injects another chat's messages on
  chat-switch; reactions survive reload (history now returns them); channel
  ownership transfer moves `channel_role`.
- **Calls**: audio-relay fallback no longer re-sends `call_invite` (which made
  the callee busy-auto-reject and kill the call).
- **Data integrity**: `ON DELETE SET NULL` FKs for `reply_to_id` +
  `login_events.device_id`; single-choice poll double-vote race serialized.
- **TOTP/2FA**: verification accepts ±1 step (RFC 6238) — tolerant of client
  clock drift.
- **Outbox**: queued sends past a 24h absolute age are dropped (poison-entry bound).
- **Admin**: account groups/tiers (creator/admin/premium/regular/test) + bulk
  assignment; prod `/admin` 429 fixed (edge rate-limit zone).

### Added (media + release hygiene)
- **Media lifecycle** (WhatsApp-style): server LRU eviction + 30-day retention
  purge + orphan cleanup + per-user quota, with a client IndexedDB cache and
  eviction→restore (re-encrypt from local cache). Now covered by an
  evict→restore integration test.
- **Repo privacy pass**: personal paths/host scrubbed from tracked files.

### Added
- **Release pipeline**: `.github/workflows/release.yml` builds a signed
  Android APK + Tauri desktop bundles (Linux/Win/macOS) on any `v*` tag
  and opens a draft GitHub Release. See `docs/RELEASE.md`.
- **Desktop client scaffold**: Tauri 2.x shell at `desktop/tauri/` with
  OS keychain bridge (`keychain_get`/`_set`/`_delete`). On the client
  the new `lib/native-keychain.ts` no-ops on web and routes to
  `invoke()` on Tauri; vault-modal silently unlocks via the stashed
  PIN on next launch.
- **Privacy + Terms pages** at `/legal/privacy` and `/legal/terms`,
  reachable without auth. Linked from the login footer alongside the
  source-code link.
- **Per-username login lockout** (`server/src/lib/auth-lockout.ts`)
  after 5 failed `/auth/verify` attempts in 15 min; backed by Redis
  with in-memory fallback. `/auth/challenge` refuses to issue nonces
  while locked.
- **`/auth/challenge` per-IP throttle** (20/min) layered on top of
  the existing 5/15min budget.
- **S3 cleanup on chat/message delete** —
  `server/src/lib/media-cleanup.ts` frees MinIO blobs immediately
  rather than waiting for the 30-day retention sweep.
- **Service worker cache wipe + keychain scrub on logout** —
  `wipeAllClientLocalState()` now drops every Cache Storage entry and
  removes Tauri keychain slots.
- **Operations runbook** (`docs/OPS.md`) covering backups, restore
  drill, uptime monitoring, incident response, rollback.
- **Backup + uptime systemd units** (`infra/systemd/`) — user-level
  timers (no sudo). Backup at 03:17 UTC with GFS retention (7d / 4w /
  6m), optional off-site rsync, optional Healthchecks.io heartbeat.
  Restore drill: `scripts/backup-restore.sh`.
- **`/version` endpoint** + client banner that nudges users to reload
  after a deploy (`client/src/components/version-update-banner.tsx`).
- **`TENOR_DEMO_API_KEY` env override** for the GIF demo key.
- **`TOTP_WRAP_KEY` startup warning** when missing in dev.

### Changed
- **Server layout migrated** to `~/sites/onetothree.ru/` matching the
  rest of the host. `docker compose name: forestmessenger` keeps the
  named volumes intact across the move.
- **Ratchet state at rest**: clarified that AES-GCM wrapping under
  `sessionWrapKey` is already enforced (stale doc fixed); signed
  prekey id now uses `crypto.getRandomValues` instead of
  `Math.random`.
- **Tauri CI workflow** (`tauri-build.yml`) builds desktop bundles
  on every push touching `desktop/tauri/**` or `client/**`.

### Fixed
- Static-export build of `/_not-found` failed because the root layout
  awaited `headers()` even in `NEXT_EXPORT=1` mode; skipped now.
- ECDSA verify accepts hex and base64url encodings, not just standard
  base64.
- Hardcoded `text-white` in mobile bottom nav replaced with a CSS token.
- `gradlew.bat` wrapper now resolves with an absolute path so msys
  invocations stop falling back to PATH lookup.

### Security
- Privacy policy now factually enumerates every server-side record and
  third-party (Tenor / Cloudflare TURN / push providers).
- Auth lockout closes a brute-force window in the original shared
  5/15min rate limit.
- Logout now reaches all four storage tiers (IndexedDB, localStorage,
  Cache Storage, OS keychain).

### Repo hygiene
- History rewritten with `git filter-repo` to drop committed build
  artifacts (`client/.next/**`, `artifacts/android/**`, etc). Repo
  shrank from 56 MB → 24 MB. Force-pushed once.

---

## [0.8.0] — 2026-05-07 — Calls Sprint (C1–C3)

### Added
- Group call rooms backed by Redis (`call_sessions` table, multi-participant support)
- Screen share indicator in call UI
- Push notification on call invite
- Missed call system message via Redis TTL expiry
- Call reject WebSocket event type (`call_reject`)
- DND (Do Not Disturb) mode with auto-reject incoming calls
- Multi-device call cancel — rejecting on one device cancels on all

### Fixed
- Font-mono scoped to terminal shell in call components (no cross-shell leakage)
- Deduplicated TURN URL helpers into `ice-servers.ts`

---

## [0.7.0] — 2026-05-07 — Polls, Channels, Waveform & Audit Fixes

### Added
- Polls (create, vote, results display)
- Channels — Telegram-style broadcast with subscriber gating and read-only input bar
- Audio waveform visualizer for voice messages
- Docker-based Android APK builder (works on any Docker host, no local SDK required)

### Changed
- Burn-after-read: timer now starts at read time, not send time

### Fixed
- Missing braces in `app.ts` and `schema.ts` (`poll_votes` table)
- TypeScript errors and middleware conflict breaking Docker builds
- Restored 3 truncated/corrupted files

---

## [0.6.0] — 2026-05-07 — Message Features Batch

### Added
- Message editing (edit history tracked)
- @mentions with notification highlighting
- Draft messages (per-chat auto-saved drafts)
- Spoiler text (hidden until tapped)

### Security
- HKDF-derived per-device keys for fan-out encryption (audit finding H-03)
- Trust store with ECDH key fingerprint pinning and change warnings (audit finding H-04)
- Fixed C-03: additional security hardening per audit report

### Fixed
- Mobile touch-target sizes for retro/terminal theme
- GIF preview: accept WebP previews in proxy, add direct-URL fallback
- Terminal shell force-activated when retro theme is selected
- iOS PWA: safe area / viewport fixes for notch, home indicator, landscape mode
- CORS CSP: enumerate `connect-src` instead of wildcards
- Link preview CSP and TURN fallback

---

## [0.5.0] — 2026-04-28 — Double Ratchet & Multi-Device

### Added
- Double Ratchet v2 (X3DH + Signal DR) — always-on for 1:1 chats
- Identity key directory: `identity_keys`, `signed_prekeys`, `one_time_prekeys` tables
- X3DH session establishment (`GET /api/keys/bundle/:userId`)
- One-time prekey replenishment (server replenishes when < 5 remain)
- Safety numbers: Signal-compatible 60-digit fingerprint for out-of-band verification
- WebAuthn vault unlock as alternative to vault passphrase
- Device history sync (`POST /api/users/me/devices/:deviceId/history-sync`)
- QR device linking (`link/init` + `link/confirm`)

### Changed
- Vault upgraded to v4: Argon2id (t=3, m=64 MiB, p=1) + AES-256-GCM
- Legacy vault blobs (v1–v3, PBKDF2) auto-upgraded on unlock

### Fixed
- Device relink flow and message delivery schema
- Gate Double Ratchet to single-device chats via `getDrFanoutSafety`
- Media picker previews rendering

---

## [0.4.0] — 2026-04-22 — Production Stack & E2EE Fan-out

### Added
- Fan-out per-device E2EE: each message encrypted per recipient device
- `message_deliveries` table (per-device ciphertext + iv slots)
- ECDSA P-256 challenge-response authentication (no passwords)
- TOTP 2FA (RFC 6238) with Redis-backed replay guard
- TOTP step-up enforcement on sensitive routes (`X-TOTP-Code` header)
- JWT denylist in Redis for logout and session revocation
- Recovery key setup and verification
- Rate limiting per route handler
- SSRF guard on link preview (`/api/link-preview`)
- Background Sync API outbox (IndexedDB `p13-outbox`) for failed send retry
- GIF proxy and search endpoint
- Admin panel (`/admin`)

### Infrastructure
- Full Docker Compose production stack (7 containers)
- Caddy reverse proxy with automatic Let's Encrypt TLS
- coturn TURN/STUN server with host networking
- MinIO S3-compatible media storage
- Presigned PUT URL flow (server never touches plaintext media bytes)
- Media served from isolated `s3.` subdomain (XSS prevention)
- Docker secrets for all credentials
- `startup.sh` one-command deploy with internal secret generation
- `db-migrate` one-shot container for Drizzle ORM migrations
- Automated backup script with optional AES-256-CBC encryption

### Security
- Files uploaded to MinIO via presigned PUT — server never handles plaintext bytes
- `TRUST_PROXY=1` support for Cloudflare/reverse proxy IP forwarding

---

## [0.3.0] — 2026-04-17 — WebRTC Calls & Groups

### Added
- Voice/video calls via WebRTC (DTLS-SRTP, TURN relay required)
- coturn integration and ICE configuration
- Group chats (SECTOR mode) with AES group key wrapped per member
- Group roles: admin, owner, kick, promote, transfer ownership
- Open groups and public discovery (`ExploreModal`, `discoverChats` API)
- File/media sharing: image, video, audio, document (client-side encrypted)
- Media albums and attachment envelope markers
- Reaction system
- Reply-to (threaded replies)
- Pin messages
- Read receipts
- Presence (online / last seen) via WebSocket + Redis

---

## [0.2.0] — 2026-04-15 — Core Messaging & PWA

### Added
- End-to-end encrypted 1:1 messaging with AES-GCM-256
- ECDH P-256 key exchange
- Browser vault: Argon2id KDF + AES-GCM-256 key storage
- Zustand state management (chat, call, session, theme stores)
- PWA support: installable, service worker, offline cache
- Web Push notifications (VAPID)
- Android APK via Capacitor
- Drizzle ORM schema: users, devices, chats, messages, chat_members
- WebSocket relay for real-time message delivery
- i18n infrastructure (EN + RU)
- Two UI shells: MD3 (Material Design 3) and Cyberpunk/Terminal

---

## [0.1.0] — 2026-04-01 — Initial Release (Phase 1)

### Added
- Project scaffolding: Next.js 16 + Fastify 5 monorepo
- Basic chat UI with cyberpunk theme
- PostgreSQL with Drizzle ORM
- Docker Compose development setup
- Initial user authentication flow
- CI/CD workflows (GitHub Actions)

---

[Unreleased]: https://github.com/therudywolf/OneToThree/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/therudywolf/OneToThree/compare/v0.5.0-alpha.1...v0.9.0
[0.8.0]: https://github.com/therudywolf/OneToThree/commits/main
