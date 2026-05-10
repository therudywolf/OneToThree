# Changelog

All notable changes to OneToThree are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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

[Unreleased]: https://github.com/therudywolf/OneToThree/compare/HEAD...HEAD
[0.8.0]: https://github.com/therudywolf/OneToThree/commits/main
