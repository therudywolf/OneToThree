# OneToThree — Architecture

## Monorepo layout

```
client/   — Next.js 16 App Router PWA (UI, local cryptography, WebRTC client)
server/   — Fastify 5 REST + WebSocket API (Drizzle ORM, S3 presign)
server/drizzle/ — SQL migrations
docker/   — coturn, LiveKit, db-migrate configs
scripts/  — setup, secret generation, audits
```

## Authentication

ECDSA P-256 challenge-response — no passwords.

1. `POST /api/auth/challenge` → `{ nonce }`
2. Client signs nonce with local ECDSA P-256 private key from vault
3. `POST /api/auth/verify` → server verifies against stored public JWK, sets `fm_session` cookie (JWT)
4. Sensitive routes (device management, device linking) require TOTP step-up via `X-TOTP-Code` header

## Encryption model

**Vault**: Private keys are stored as PBKDF2 (600k iterations) + AES-256-GCM blobs in localStorage. Optionally synced server-side as an opaque blob (server cannot decrypt). Vault unlock triggers ECDH key re-upload.

**Direct (1:1) and Self (Saved Messages) — fan-out per-device encryption**:
1. Sender fetches ECDH public keys for all devices of both participants via `GET /users/:id/devices`
2. For each device: `ECDH(senderPriv, deviceEcdhPub)` → AES-256-GCM key → encrypt plaintext
3. POST body carries `ciphertexts[]` (one slot per device). Server stores per-device rows in `message_deliveries`
4. Receiver: `ECDH(receiverPriv, senderEcdhPub)` → same key → decrypt their slot

**Group messages (SECTOR mode)**: Symmetric AES group key, wrapped per member with their ECDH key. Stored in `chat_members.encrypted_group_key`.

**Public chats**: Plaintext base64, no encryption.

**Double Ratchet v2** (gated by `NEXT_PUBLIC_DR_ENABLED=1`): Signal-compatible X3DH + DR implementation. On vault unlock, identity bundle is generated/loaded, persisted to IndexedDB (AES-GCM wrapped), and public halves published to `/api/keys`. Wire format sentinel: `iv = "dr:v2"`.

## Message send flow (direct chat)

```
chat-input.tsx
  → useSendMessage (hooks/use-send-message.ts)
      → sendChatMessageOverTransport() (lib/chat-message-transport.ts)
          → buildFanoutSlots()     ← fetches device ECDH keys, encrypts per device
          → POST /api/messages/send
              → server: persistChatMessageAndFanOut() + broadcastToUsers() via WS
```

Failed sends are queued to IndexedDB (`p13-outbox`) for Background Sync API retry.

## Message receive flow

WebSocket events arrive in `hooks/use-chat-realtime.ts`:
- Fan-out WS events: `content: null` → client calls `fetchPendingDeliveries()` → `decryptFanoutSlot(receiverPriv, senderEcdhPub, deviceCiphertext, iv)`
- Group/legacy messages: carry `content` directly → `decryptInboundText()`
- DR v2 messages: `iv === "dr:v2"` → `decryptFromPeer()`

## WebRTC calls

- Clients exchange `offer`, `answer`, `ice` through WebSocket relay (`webrtc_signal`)
- Server relays targeted payloads; does not parse SDP/ICE semantics
- TURN relay: coturn on host network; `turn.*` subdomain must be DNS-only (not proxied by Cloudflare)
- LiveKit SFU optional for 3+ participant calls; `POST /api/call/token` issues room JWT

## Media

- Client encrypts media bytes client-side (AES-GCM)
- Server issues presigned MinIO PUT URL; server never touches plaintext bytes
- Files served from a separate subdomain (`s3.domain`) to prevent script XSS

## Server structure

```
server/src/routes/   — one file per domain (auth, messages, users, chats, ws, webrtc, devices, vault, keys, push, storage, admin)
server/src/lib/      — shared utilities (auth-user, ecdsa-verify, chat-message-persist, totp, jwt-denylist, etc.)
server/src/ws/registry.ts — WebSocket connection manager; broadcastToUsers()
server/src/db/schema.ts   — all Drizzle table definitions
```

## Client structure

```
client/src/app/            — Next.js App Router pages
client/src/components/chat/ — chat UI; chat-app.tsx is the main shell
client/src/hooks/          — domain hooks (use-send-message, use-chat-realtime, use-messages, etc.)
client/src/lib/            — crypto, transport, fanout, ratchet, vault, media, outbox
client/src/store/          — Zustand stores (chatStore, callStore, toastStore, themeStore)
client/src/lib/ratchet/    — Double Ratchet: double-ratchet.ts, session-manager.ts, x3dh.ts, kdf.ts, keys.ts
```

## Security boundaries

- Private keys never leave the browser vault
- Server stores only public keys, ciphertext blobs, encrypted media metadata
- MinIO stores ciphertext only
- Full-text search is local client-side only (IndexedDB plaintext index)
- JWT denylist in Redis for logout + revocation
- TOTP replay guard — each code is single-use (Redis)
- Secrets injected via Docker secrets (`/run/secrets/*`), never in env files at runtime
