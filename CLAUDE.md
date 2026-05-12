# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**OneToThree** is a self-hosted end-to-end encrypted messenger. Zero-trust architecture: the server stores only ciphertext, all cryptographic operations happen in the browser via Web Crypto API. Private keys never leave the browser.

Stack: Next.js 16 (frontend) + Fastify 5 (backend) + PostgreSQL (Drizzle ORM) + Redis + MinIO (S3) + Caddy (reverse proxy with auto-TLS).

Quick references: `docs/project/ARCHITECTURE.md` (architecture overview), `docs/project/FEATURE_MATRIX.md` (implementation status per feature — check before assuming something is complete), `docs/project/MIGRATION_NOTES.md` (message format / DB migration invariants across refactor phases), `docs/project/CLAUDE_HANDOFF.md` (current sprint state and open blockers — read before starting a session).

## UI Theme Architecture (critical)

The project has **two fully independent UI shells** that must both work correctly after every UI change:

| Shell | `data-shell` attribute | Character |
|-------|----------------------|-----------|
| **MD3** | `"md3"` | Material Design 3 — Google Sans, rounded, dynamic colors |
| **Cyberpunk / Terminal** | `"terminal"` | Monospace, neon, CRT/glitch, ASCII rhythm |

**Rules:**
- Every UI/UX commit must be tested in **both** shells.
- Component styles must be scoped strictly to `[data-shell="md3"]` or `[data-shell="terminal"]`.
- `[data-theme="..."]` attributes hold palette tokens only — no component layout rules go there.
- No cross-shell leakage: MD3 must not pick up monospace fonts; terminal must not pick up Google Sans.

## Commands

All commands from repo root unless noted.

```bash
# Setup (first time)
node scripts/bootstrap.js

# Dev servers (run separately in two terminals)
npm run dev:client        # Next.js on :3000
npm run dev:server        # Fastify (tsx watch) on :8080

# Build
npm run build             # client + server
npm run typecheck         # tsc --noEmit across both workspaces

# Linting
npm run lint              # ESLint, zero warnings policy

# Tests
npm run test:server       # Vitest, server only
npm run test:unit:client  # Vitest, client unit only
npm run test:e2e          # Playwright e2e
npm run test:p0:auth      # P0 auth smoke suite (bash)
npm run test:stages:all   # Full stage quality-gate suite (bash)
npm run test:all          # typecheck + lint + all tests

# Run a single server test file
cd server && npx vitest run src/routes/auth.test.ts

# Run a single client test file
cd client && npx vitest run src/lib/crypto.test.ts

# Docker (full local stack)
npm run docker:up          # builds + starts all 7 services
npm run docker:down

# Database
npm run db:generate       # generate Drizzle migration from schema changes
npm run db:push           # push schema to running DB (dev only)
npm run db:push:docker    # push via docker.db.env
npm run db:studio         # open Drizzle Studio UI

# Utilities
npm run check:locales     # validate i18n key parity across locale files
npm run cors:smoke        # CORS preflight smoke test
npm run audit:security    # security lint audit
npm run audit:security:strict  # strict mode (STRICT=1)
npm run backup            # run backup script

# Double Ratchet is always enabled for 1:1 chats
```

## Architecture

### Monorepo layout
```
client/   — Next.js 16 App Router PWA
server/   — Fastify 5 REST + WebSocket API
docker/   — coturn, LiveKit, db-migrate configs
scripts/  — setup, secret generation, audits
```

### Encryption model (critical to understand before touching crypto code)

**Authentication**: ECDSA P-256 challenge-response — no passwords. Client signs a server nonce, server verifies against stored public JWK. Session represented by `fm_session` cookie (JWT).

**Direct (1:1) messages — fan-out per-device encryption** (`client/src/lib/fanout-crypto.ts`):
1. Sender fetches ECDH public keys for ALL devices of both participants via `GET /users/:id/devices`
2. For each device: `ECDH(senderPriv, deviceEcdhPub)` → AES-256-GCM key → encrypt plaintext
3. POST body carries `ciphertexts[]` (one slot per device). Server stores per-device rows in `message_deliveries`.
4. Receiver: `ECDH(receiverPriv, senderEcdhPub)` → same key → decrypt their slot.

Device ECDH keys are uploaded to the server via `PATCH /users/me` (`ecdh_public_key_jwk`) each time the vault is unlocked — this updates both `users.ecdhPublicKeyJwk` AND `devices.ecdhPublicKey` for the current device.

**Group messages** (`mode: SECTOR`): Symmetric AES group key, wrapped per member with their ECDH key. Stored in `chat_members.encrypted_group_key`.

**Vault**: Vault blobs are versioned. Legacy v1-v3 use PBKDF2 (600k) + AES-256-GCM; current v4 uses Argon2id (t=3, m=64 MiB, p=1) + AES-256-GCM. `upgradeVaultBlob()` re-wraps legacy blobs to v4. Vault is optionally synced server-side as an opaque blob (server cannot decrypt). Vault unlock triggers ECDH key re-upload.

**Double Ratchet (v2)** (`client/src/lib/ratchet/`): Signal-compatible (X3DH + DR) implementation, always enabled for 1:1 chats. On vault unlock, `dr-bootstrap.ts` is invoked to:
  1. Generate or load the local DR identity bundle (Ed25519 + X25519 + signed prekey + OTPKs)
  2. Persist the bundle to IndexedDB (`forest-dr-identity` store) wrapped with a vault-derived AES-GCM key
  3. Publish public halves to `/api/keys`; replenish one-time prekeys if server reports < 5 remaining

`session-manager.ts` handles X3DH session bootstrap (`bootstrapSession`/`acceptSession`) and per-message DR encrypt/decrypt (`encryptForPeer`/`decryptFromPeer`). Wire format: `{ protocolVersion: 2, drHeader, iv: "dr:v2" sentinel, ciphertext }`. `chat-crypto.ts` exposes `encryptOutboundTextV2`/`decryptInboundTextV2` as integration points, but the send path still uses v1 fan-out.

**Safety numbers**: `client/src/lib/ratchet/safety-number.ts` — Signal-compatible 60-digit fingerprint (SHA-512, 5200 iterations) over a sorted pair of identity public keys for out-of-band identity verification.

**Trust store**: `client/src/lib/trust-store.ts` — DJB2-checksummed localStorage registry mapping peer user IDs to their pinned ECDH public key fingerprints.

### Message send flow (direct chat)

```
chat-input.tsx
  → useSendMessage (hooks/use-send-message.ts)
      → encryptOutboundText()       ← v1 only; result discarded for DIRECT mode
      → sendChatMessageOverTransport() (lib/chat-message-transport.ts)
          → buildFanoutSlots()      ← fetches device keys, encrypts per device
          → POST /api/messages/send
              → server: persistChatMessageAndFanOut() + broadcastToUsers() via WS
```

If `buildFanoutSlots` returns 0 slots (no device ECDH keys on server), the client throws `DIRECT_FANOUT_UNAVAILABLE`. The server also enforces `DIRECT_FANOUT_REQUIRED` — it rejects direct-chat messages without `ciphertexts[]`.

Failed sends are queued to IndexedDB (`p13-outbox` store, `client/src/lib/outbox.ts`) for Background Sync API retry.

`PUBLIC` chats are intentionally non-E2EE: payload is plaintext base64 for compatibility/discovery flows; UI must keep explicit "no E2E" warnings.

### Message receive flow

WebSocket events arrive in `hooks/use-chat-realtime.ts`:
- Fan-out WS events have `content: null` → client calls `fetchPendingDeliveries()` then `decryptApiMessageRows()` → `decryptFanoutSlot(receiverPriv, senderEcdhPub, deviceCiphertext, iv)`
- Legacy/group messages carry `content` directly → `decryptInboundText()`
- DR v2 messages: `iv === DR_SLOT_SENTINEL` triggers `decryptFromPeer()` via `DrContext`

### Server structure

`server/src/routes/` — one file per domain (auth, messages, users, chats, ws, webrtc, devices, vault, keys, push, storage, admin)  
`server/src/lib/` — shared utilities (auth-user, ecdsa-verify, chat-message-persist, totp, jwt-denylist, device-session, s3, presence, redis, etc.)  
`server/src/ws/registry.ts` — WebSocket connection manager; `broadcastToUsers()` delivers fan-out events  
`server/src/db/schema.ts` — all Drizzle table definitions

### Client structure

`client/src/app/` — Next.js App Router pages  
`client/src/components/chat/` — all chat UI; `chat-app.tsx` is the main shell  
`client/src/hooks/` — domain hooks (`use-send-message`, `use-chat-realtime`, `use-chat-crypto-context`, `use-messages`, etc.)  
`client/src/lib/` — crypto, transport, fanout, ratchet, vault, media, outbox; notable modules: `webauthn-vault.ts` (WebAuthn as vault unlock alternative), `client-wipe.ts` (nuclear local-state clear), `chat-permissions.ts` (role-gated action checks), `chat-folders.ts` (folder/filter state), `attachment-envelope.ts` (wire envelope: attachment/album/sticker markers)  
`client/src/store/` — Zustand stores: `chatStore` (selected chat, messages), `callStore` (WebRTC state), `toastStore`, `themeStore`, `sessionStore` (auth session), `presenceStore` (online/last-seen), `unreadStore` (badge counts)  
`client/src/lib/ratchet/` — Double Ratchet: `double-ratchet.ts` (state machine), `session-manager.ts` (X3DH + persistence), `x3dh.ts`, `kdf.ts`, `keys.ts`, `session-store.ts` (IndexedDB), `local-bundle-store.ts` (vault-wrapped identity bundle), `dr-bootstrap.ts` (vault-unlock orchestration), `safety-number.ts`, `sender-keys.ts` (group DR, not wired)

### Key API types

`SendChatMessageTransportInput` (`lib/chat-message-transport.ts`) — transport contract between UI and send logic  
`ChatCryptoContext` (`lib/chat-crypto.ts`) — discriminated union: `DIRECT | SELF | SECTOR | PUBLIC`  
`ApiMessageRow` (`lib/decrypt-chat-api-message.ts`) — shape of messages returned by the server  
`DecryptedMessage` (`types/chat.ts`) — hydrated message with `plaintext` field  
`BundleResponse` (`lib/api/keys.ts`) — X3DH bundle returned by `GET /api/keys/bundle/:userId`

### Database schema highlights

`messages` — stores encrypted ciphertext; for direct chats `content`/`iv` are null (fan-out only)  
`message_deliveries` — per-device slots: `device_id`, `ciphertext`, `iv`, `delivered`, `read`  
`devices` — `ecdhPublicKey` is the per-device ECDH key used for fan-out; `revokedAt` gates access  
`users` — `ecdhPublicKeyJwk` mirrors current device ECDH key; `vaultBlob` is the opaque encrypted vault  
`identity_keys`, `signed_prekeys`, `one_time_prekeys` — DR/X3DH key directory tables
`chat_type` includes `channel` (backend+schema shipped; full UI flow still partial)
`sticker_packs`, `stickers`, `sticker_format` — Telegram sticker directory/import schema

### Call transport policy

Calls require TURN relay — there is **no STUN-only fallback**. If TURN (coturn / Cloudflare TURN) is not configured, `/api/turn` and `/api/ice-servers` return `503 TURN_NOT_CONFIGURED` and the call will not connect. Do not add client-side ICE fallback paths or auto-switch logic.

### Key server routes not in API.md

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/keys/identity` | Publish/rotate DR identity key pair (one-shot per generation) |
| `POST` | `/api/keys/signed-prekey` | Publish/rotate signed prekey |
| `POST` | `/api/keys/one-time` | Upload one-time prekeys (max 200 per user) |
| `GET` | `/api/keys/inventory` | Count remaining OPKs |
| `GET` | `/api/keys/bundle/:userId` | Atomic X3DH bundle fetch (pops one OPK) |
| `POST` | `/api/auth/recovery/setup` | Store hashed recovery key |
| `POST` | `/api/auth/recovery/verify` | Verify recovery key for vault restore |
| `POST` | `/api/users/me/devices/:deviceId/history-sync` | Approve history sync for linked device |
| `POST` | `/api/users/me/devices/:deviceId/link/init` | Initiate QR device linking |
| `POST` | `/api/users/me/devices/:deviceId/link/confirm` | Confirm device link |
| `GET` | `/api/link-preview` | Fetch URL metadata with SSRF guard (DNS allowlist + TCP pinning, `server/src/lib/link-preview-ssrf.ts`) |
| `GET` | `/api/messages/search` | Removed server-side search: returns `410 Gone`; client search is local IndexedDB |

### TOTP step-up

Sensitive routes (device management, device-link toggle) require a valid TOTP code in the `X-TOTP-Code` request header when TOTP is enabled for the account. Enforced by `requireTotpStepUp()` in `server/src/lib/totp-stepup.ts`. Each code is single-use (replay guard in Redis).

### Infrastructure (Docker Compose production)

Caddy (auto-TLS via Let's Encrypt) → Next.js :3000 + Fastify :8080 + MinIO :9000  
coturn on host network for WebRTC TURN relay  
LiveKit SFU (optional) for 3+ participant calls  
DB migrations run in a one-shot `db-migrate` container on startup

### Security conventions

- Secrets injected via Docker secrets (`/run/secrets/*`), never in env files at runtime
- Rate limits defined inline in route handlers via `config: { rateLimit: {...} }`
- All file uploads go via presigned MinIO PUT URLs; server never touches plaintext bytes
- Files served from a separate subdomain (`s3.domain`) to prevent script XSS via uploads
- JWT denylist in Redis (`lib/jwt-denylist.ts`) for logout + revocation
- TOTP replay guard (`lib/totp-replay-guard.ts`) — each code usable once
- Media search is local client-side only; server never receives plaintext
- `client-wipe.ts` provides a nuclear local-state clear (vault, IndexedDB, localStorage) for emergency logout scenarios
