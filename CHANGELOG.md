# Changelog

All notable changes to OneToThree are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

Six weeks of work on the three surfaces people actually spend time in: **calls**
(rebuilt, with a real media pipeline behind them), **guests** (let someone into a
meeting or a temporary chat without an account), and **channels** (which finally
have a face and, more to the point, a working composer).

### Added
- **The call screens are rebuilt.** 1:1 and group share one tile component and
  gain a participants panel, a draggable floating window (PiP), a stats/debug
  panel, and an in-call side chat that docks the *real* chat next to the call
  rather than a stripped-down copy.
- **Camera background blur and replacement.** MediaPipe selfie segmentation runs
  in a dedicated Worker on OffscreenCanvas, driven by the capture stream instead
  of main-thread timers — so a backgrounded tab keeps full frame rate instead of
  collapsing to ~1 fps. The DOM pipeline stays as the non-Chromium fallback.
  Segmentation assets are self-hosted; nothing is fetched from a CDN.
- **Noise suppression on your microphone** — an AudioWorklet noise gate plus an
  optional RNNoise ML denoise stage, and a "hear yourself" mic check in Settings
  that loops back through the real processing chain so you can judge it before a
  call rather than during one.
- **Camera and screen at the same time.** A share now rides its own senders, so
  your face keeps flowing while you present: the other side gets a separate
  screen tile, you get your own preview, and the camera is untouched throughout.
  Works in 1:1, in mesh group calls, and on the LiveKit path — which now
  publishes the *processed* mic and camera, so the gate and the background
  effects apply in group calls too.
- **Screen share up to 4K at 120 fps**, with the encoder budget pushed onto the
  sender (the old ~2.5 Mbps cap made 4K unusable), stereo tab/system audio, a
  share-audio mute that silences the captured sound without stopping the video,
  and `Ctrl+Shift+M` / `Ctrl+Shift+D` mute/deafen hotkeys.
- **Completed calls appear in the timeline**, with talk duration — until now the
  history showed only missed ones. Exactly one event per call, whoever hangs up
  first.
- **A mid-call page reload redials.** Instead of a dead call, the app reopens the
  chat and rings again once the socket is back; the peer just sees a fresh ring.
- **Guest links — let someone in without an account.** Opt-in via
  `FEATURE_GUESTS` (**default off**; nothing changes on an existing install
  until an operator turns it on). Two flavours:
  - **Meeting guests.** Mint a link, a stranger opens it, picks a name and
    knocks; you approve each one personally and they land in the call with a
    short-lived LiveKit token. **No account row is ever created.** Links carry
    *seats*, so one link can admit a whole meeting; a `/meet/<room>` page lets
    the host into their own standalone meeting. Guests are badged on the call
    tile and in the participants panel — from the server-issued token, so nobody
    can badge or un-badge themselves by renaming — and the host can remove one.
  - **Temporary chats.** A one-seat link opens an E2EE chat with an ephemeral
    guest whose keys live only in that browser tab: close it and there is no way
    back. The guest is badged in the chat header too, the host can end the chat
    at any time, and account plus conversation are purged together — on leave,
    on kick, after an offline grace period, or at the hard TTL.

    Every API route is deny-by-default for a guest session: a new route is
    closed to guests until someone adds it to the allowlist by hand.
- **Channels have a face.** A channel can now be renamed (the name used to be
  write-once), described, given a picture, and kept out of the public catalog
  while staying joinable by link. All of it shows where a channel is actually
  met — the chat list, the chat header, discovery, and the profile card — and a
  channel is no longer indistinguishable from a group: it gets a megaphone and
  counts subscribers.
- **You can post in a channel.** Channels shipped as "implemented" while the
  composer was disabled for everyone including the owner. Posting works, and
  subscriber/editor roles and the discussion-group link have the routes the
  client had been calling into a 404.
- **A personal channel on your profile** — pin one of your channels as a wall,
  Telegram-style; visitors get a channel card with a join handle.
- **`FEATURE_OPEN_REGISTRATION`** (default on) closes self-registration, so guest
  links can be the only door for strangers.

### Changed
  *no-domain / this machine* (HTTP on `localhost`, everything works incl. media),
  *no-domain / LAN* (self-signed HTTPS via Caddy's internal CA so E2EE works off the
  local machine — Web Crypto needs a secure context, which plain HTTP over a LAN IP
  can't provide), and *domain* (Let's Encrypt). Fixes the prior footgun where a LAN
  IP over plain HTTP produced a crypto-less, broken instance. `docker-compose.lite.yml`
  gains `OT_HTTPS_CONTAINER_PORT` so LAN mode publishes its HTTPS port 1:1.
- **Release notes** now clearly separate **client apps** (download & connect to the
  hosted service) from **self-hosting** (`npm run lite`, not a download).
- **Your display name is real.** Setting one used to change nothing anybody could
  see — it never left the profile modal. The chat list and chat header now prefer
  it over the immutable `@handle`.
- **Finding your own profile takes one click.** Your avatar sits at the top of
  the rail with a small menu; the dock profile on wide screens carries the same
  bio, status, links and channel card the modal always had; and browsing the
  public catalog moved next to the peer search, because finding someone else's
  room is not creating one.
- **Guest rate limits are sized per meeting, not per person.** Guests share an
  address constantly — one office, one flat, one conference room — and the
  original budget locked the sixth guest of a ten-seat meeting out for a quarter
  of an hour holding a link that was still perfectly valid.
- **Android push has instructions.** `google-services.json` is per-project and
  gitignored, so a clean checkout built an APK that looked healthy and simply
  never received a notification. That is now a loud warning at build time, and
  both halves of the FCM setup (app and server) are written down.
- **Deploys refuse to race each other.** Two `docker compose up --build` runs
  reaching the container-swap phase together left the API removed and not
  restarted — production down until a human noticed. A deploy now declines to
  start while another is in flight.
- Dropped the dead Discord-era `groups` / `channels` / `group_messages` /
  `message_threads` models and their 72 orphaned locale keys. (The physical
  tables are left alone — dropping those is a separate, irreversible decision.)

### Fixed
- **The first message from a new contact was lost.** On a cold load, opening a
  direct chat reached history decryption before the vault finished installing the
  Double Ratchet identity. Losing that race rendered `[DECRYPT_FAIL]` and nothing
  ever retried it — so the single most visible message there is, the first one
  somebody ever sends you, was the one that broke.
- **A message could show as undecryptable while decrypting perfectly well.**
  Opening a chat can put the history load, the realtime pull and the pending sync
  on the same envelope in one tick; the ratchet serialises them, and the losers
  failed against a message key that no longer existed. They now share one
  decrypt.
- **Group messages could be stranded behind the sender's own re-key.** The client
  that performed a rotation kept its superseded key and sealed everything it sent
  next with a key no other member would ever hold — unreadable for the whole
  group, forever, and silent, because the sender reads its own copy back from its
  own ring. Group creation also kicked off two rotations in a row.
- **Decrypt failures say what went wrong.** Every failing branch used to be
  silent: single rows swallowed the reason, batched group/sector rows swallowed
  the whole epoch ring, and a chat with no key ring at all rendered every bubble
  *empty* — which reads as a rendering glitch rather than a key problem. Reasons
  are now logged (never key material, never plaintext).
- **A guest's messages reached nobody.** The route allowlist named a URL
  parameter `:id` where the real route registers `:userId`, so the guest's device
  lookup 403'd, the fan-out went out to an empty device list, and the host simply
  never saw the message. Parameter names can no longer matter, and every
  allowlist entry is now pinned against the live route table.
- **The guest sweeper had been failing on every tick in production** since the
  feature shipped: only the hard-expiry pass ever ran, so guests who just closed
  the tab were never reclaimed and expired invite rows accumulated forever.
- **Call UI**: the control bar sat under the browser chrome with its buttons
  looking cut off; call events rendered their raw JSON in a bubble when read from
  the local cache; and a replacement background image silently never loaded under
  the production CSP, falling back to blur.

## [0.10.0] — 2026-07-03 — OneToThree **Lite**: one-click self-host + feature flags

Stand up your **own** end-to-end-encrypted instance anywhere, with only the
features you want. The full edition (default `main`) is unchanged — every feature
flag defaults ON — so this release adds a configuration + packaging layer plus
capability gating, without altering existing behaviour.

### Added
- **Guided one-command installer** (`npm run lite` → `scripts/lite/install.mjs`,
  plus `install.sh` / `install.ps1`). Asks for **local** (plain HTTP on
  localhost/LAN) or **domain** (automatic HTTPS via Let's Encrypt) mode, the
  host/port or domain + ACME email, and a **checkbox** feature set; then generates
  secrets, writes `.env.lite` + a valid `infra/lite/Caddyfile`, selects the compose
  profiles and launches. Guide: `docs/guides/LITE.md` (EN + RU).
- **Single-origin stack** `docker-compose.lite.yml` — web + `/api` + `/api/ws` all
  behind one Caddy, so Lite needs **one** hostname (or just `localhost`), not five.
  MinIO is pulled in only by the `media` profile; a small Postgres + Redis complete
  the core. `db → migrate → api → web → caddy` health-gated startup.
- **Feature flags** (`FEATURE_MEDIA/CALLS/STICKERS/GIF/PUSH/2FA/ADMIN/GROUPS`, all
  default ON) exposed via `GET /capabilities` (root **and** `/api/capabilities`).
- **Capability-aware UI** — a `CapabilitiesProvider` fetches `/api/capabilities`
  once (fail-open to all-on) and hides surfaces a disabled instance doesn't run:
  call button + incoming/active/group call UI, media attach/record (and drag/paste),
  GIF & sticker tabs, sticker/push/2FA settings, admin link. No dead buttons.
- **Server-side enforcement** — disabled features are removed from the API too, not
  just the UI: their route groups aren't registered (→ 404), the shared storage
  module 403s chat-media endpoints while `/avatar-url` stays open, and the WS layer
  rejects call/WebRTC signaling on a calls-off instance.

### Notes
- **Calls** aren't bundled (a LiveKit SFU needs coturn + open UDP): the installer
  asks for an **external** LiveKit URL/key/secret and wires them to the API
  (`OT_LIVEKIT_*`) — no web rebuild. A bundled LiveKit is on the roadmap.
- Roadmap for later sprints (local-FS media without MinIO, bundled LiveKit+coturn,
  Android `build:selfhost`, GUI installer): `docs/project/ROADMAP_SELFHOST_LITE.md`.

## [0.9.3] — 2026-07-03 — Stickers: create-your-own packs + audit backlog

Second pass on the sticker/GIF/search audit — the create-your-own-pack feature
plus the remaining verified backlog.

### Added
- **Create your own sticker packs — no Telegram needed.** Settings → Stickers has
  a "Create your own pack" box (name → Create) and a ＋ button on each of your
  packs to upload image stickers (WEBP/PNG/JPG/GIF, ≤512 KB, ≤120/pack). New
  server routes: `POST /packs`, `POST /packs/:id/stickers`, `DELETE
  /packs/:id/stickers/:sid` (all owner-only). Your packs show up in the composer
  picker like any imported pack.

### Fixed
- **Animated (tgs/lottie) stickers now render on desktop & Android.** They were
  `fetch()`-ing a `blob:` URL, which the Tauri/Capacitor CSP `connect-src`
  doesn't allow; they now read the cached Blob directly. StickerBubble also
  passes the media key so a mislabeled pack-level format is corrected per-sticker.
- **Sticker access is now consistent.** `/asset-url` and `/media` honor the same
  implicit shared-chat access that pack detail/clone already granted, so a
  legitimate recipient no longer gets a 403 fetching the image.
- **Clones are self-owning.** Cloning copies each object to the clone's own key
  (server-side S3 copy) instead of reusing the source key — so per-pack object GC
  is correct and a clone survives the source owner deleting their pack.
- **Grant consent.** Only a pack owner can mint durable shares of a *private*
  pack; a non-owner with mere shared-chat read access can no longer spread it.
- Sticker blob: object-URL cache is now LRU-bounded (was leaking one per sticker
  for the whole session); pack thumbnails resolve concurrently (no serial N+1);
  chat-search debounce actually debounces the message scan (and collapses IME
  keystrokes); the sticker-add page validates a real UUID.

### Backend / hygiene
- `mimeForExt` covers jpg/gif; native pack + sticker upload caps
  (50 packs/user, 120 stickers/pack, 512 KB/image).

## [0.9.2] — 2026-07-03 — Stickers, GIFs & search polish

Audit + fixes across the sticker-pack, GIF, and search subsystems (web, Android, desktop).

### Fixed
- **Desktop emoji picker was blank.** The picker rendered Google-style emoji as
  PNGs from `cdn.jsdelivr.net`, which the Tauri desktop CSP (`img-src`) blocks →
  a grid of broken tiles. Switched to native system-font emoji (`EmojiStyle.NATIVE`):
  works on web/Android/desktop, no CDN, offline-friendly, no third-party requests.
- **GIF search flashed a spinner on every keystroke.** The busy state now flips
  only when a request actually fires (after the debounce); prior results stay
  visible while typing/re-searching.
- **GIF provider-down was invisible.** When Tenor/Giphy is unreachable the picker
  now shows a small "provider unavailable — showing suggestions" banner instead
  of silently presenting fallback GIFs as if they were real results (the client
  `degraded` flag was also mislabeled on the network-error path).
- **Recent-GIF tiles** now fall back to the direct provider URL if the server
  proxy 404s/rate-limits, matching the search/favorites grids.
- **Recent/favorite sticker tiles** now (a) surface a toast if a send fails
  (previously swallowed — looked like success) and (b) re-resolve their image
  after a reload (persisted `blob:` URLs die across sessions and showed broken).
- **Message search** no longer silently blanks a query for the literal words
  "undefined"/"null" (an ID-input guard was wrongly applied to free-text search).

### Added
- **Per-pack sticker filter** — large packs get a filter box (matches the
  sticker's emoji tag) instead of only a flat scroll grid.

### Backend / hygiene
- **Sticker MinIO objects are now garbage-collected** on pack delete and on
  Telegram refresh (previously every delete/refresh orphaned blobs forever).
  Clone-safe: an object is removed only when no `stickers` row (in any pack,
  including clones that reuse the key) still references it.
- **GIF favorites are capped per user** (evict-oldest beyond 200) so a client
  can't grow the table unbounded.

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

[Unreleased]: https://github.com/therudywolf/OneToThree/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/therudywolf/OneToThree/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/therudywolf/OneToThree/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/therudywolf/OneToThree/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/therudywolf/OneToThree/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/therudywolf/OneToThree/compare/v0.5.0-alpha.1...v0.9.0
