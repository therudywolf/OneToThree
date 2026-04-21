#  One To Three — Project 13 (OneToThree)

**License: [GNU Affero General Public License v3.0 (AGPL-3.0-only)](./LICENSE)**

### Clinical-grade zero-trust E2E messenger — self-hosted, open-source, no phone number required

---

> **Philosophy:** The server is the enemy. Every byte it stores is encrypted.
> Every key lives in your browser. Every call is peer-to-peer.
> If the server is seized, the attacker gets encrypted noise and timestamps — nothing else.

OneToThree is a self-hosted, end-to-end encrypted communication platform built on a
zero-trust server model. Unlike Signal (centralized, phone-number identity), Telegram
(server-side encryption optional, phone required), or Matrix (federated but complex),
OneToThree is:

| | One To Three | Signal | Telegram | Matrix |
|---|---|---|---|---|
| Self-hosted | **Yes** — you own the server | No | No | Yes (complex) |
| Phone number required | **No** — username only | Yes | Yes | No |
| E2EE by default | **All chats** | All chats | Secret chats only | Opt-in rooms |
| Server sees content | **Never** | Never | Default chats: yes | Depends on config |
| Password sent to server | **Never** — ECDSA challenge | Hashed | Hashed | Hashed |
| Media encrypted | **Per-file unique key** | Yes | No (default) | Yes |
| Calls | **WebRTC DTLS-SRTP** | WebRTC | Proprietary | Jitsi bridge |
| Single-binary deploy | **`./start.sh`** | N/A | N/A | Multiple services |

---

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [Architecture Diagram](#architecture-diagram)
3. [Cryptographic Architecture](#cryptographic-architecture)
4. [Security Audit](#security-audit)
5. [Feature Implementation Map](#feature-implementation-map)
6. [Data Flow — What the Server Sees](#data-flow--what-the-server-sees)
7. [Infrastructure](#infrastructure)
8. [Self-Hosting Guide](#self-hosting-guide)
9. [Roadmap](#roadmap)
10. [Mobile Strategy](#mobile-strategy)

---

## Technology Stack

### Frontend

| Technology | Version | Purpose |
|---|---|---|
| **Next.js** | 16.2.3 | App Router, SSR, standalone build, PWA |
| **React** | 19.2.5 | UI library (concurrent mode) |
| **TypeScript** | 5.9.3 | Type safety across client and server |
| **Tailwind CSS** | 3.4.19 | Utility-first styling, custom neon theme |
| **Framer Motion** | 11.18.2 | Animations — modals, banners, media bubbles |
| **Zustand** | 5.0.12 | Lightweight state management (call, chat, locale stores) |
| **Lucide React** | 0.577.0 | Icon library (Phone, Lock, Send, Mic, Video, etc.) |
| **emoji-picker-react** | 4.18.0 | Emoji selection in chat input |
| **Dexie** | 4.4.2 | IndexedDB wrapper — message cache, media cache, outbox |
| **idb** | 7.1.1 | IndexedDB utilities for avatar and key caching |
| **qrcode.react** | 4.2.0 | QR code rendering for device linking |
| **react-image-crop** | 11.0.10 | Avatar upload cropping |
| **browser-image-compression** | 2.0.2 | Client-side image optimization before upload |
| **next-pwa** | 5.6.0 | Service worker, offline support, push handler |
| **Web Crypto API** | Native | All encryption — AES-GCM, ECDH, ECDSA, PBKDF2 |
| **Web Workers** | Native | Off-main-thread batch decryption (crypto.worker.ts) |
| **Playwright** | 1.59.1 | End-to-end testing |
| **Vitest** | 3.2.4 | Unit testing |

### Backend

| Technology | Version | Purpose |
|---|---|---|
| **Fastify** | 5.8.4 | HTTP server + WebSocket upgrade |
| **@fastify/websocket** | 11.2.0 | Real-time messaging, call signaling, typing, presence |
| **@fastify/jwt** | 10.0.0 | Session tokens (7-day, device-scoped) |
| **@fastify/cors** | 11.2.0 | Cross-origin configuration |
| **@fastify/helmet** | 13.0.2 | Security headers |
| **@fastify/cookie** | 11.0.2 | httpOnly `fm_session` cookie |
| **@fastify/multipart** | 10.0.0 | File upload handling |
| **@fastify/rate-limit** | 10.3.0 | Brute-force protection |
| **Drizzle ORM** | 0.45.2 | Type-safe PostgreSQL queries + migrations |
| **postgres** | 3.4.9 | PostgreSQL wire protocol driver |
| **ioredis** | 5.10.1 | Redis client — QR token store, session cache |
| **@aws-sdk/client-s3** | 3.1029.0 | MinIO/S3 presigned uploads and downloads |
| **web-push** | 3.6.7 | VAPID push notifications |
| **otplib** | 13.4.0 | TOTP two-factor authentication (RFC 6238) |
| **qrcode** | 1.5.4 | QR generation for device pairing |
| **Zod** | 3.25.76 | Request schema validation |
| **Vitest** | 3.2.4 | Unit testing |
| **Supertest** | 7.2.2 | HTTP integration testing |

### Infrastructure

| Technology | Version | Purpose |
|---|---|---|
| **Docker** | — | Containerization (node:20-alpine base) |
| **Docker Compose** | v2 | Service orchestration (7 services) |
| **PostgreSQL** | alpine | Persistent storage — users, chats, messages, devices |
| **MinIO** | latest | S3-compatible encrypted media storage |
| **Caddy** | 2-alpine | Reverse proxy, automatic TLS (Let's Encrypt ACME) |
| **coturn** | 4.6 | TURN/STUN relay for WebRTC NAT traversal |
| **Redis** | — | Optional: QR token sharing for multi-node deploy |

### Protocols & Standards

| Standard | Where Used |
|---|---|
| **AES-GCM-256** | All message content, all media files, vault encryption |
| **ECDH P-256** | Key agreement for direct chats and group key wrapping |
| **ECDSA P-256 + SHA-256** | Passwordless authentication (challenge-response) |
| **PBKDF2 (600k iterations, SHA-256)** | Vault passphrase → AES wrapping key derivation |
| **WebRTC + DTLS-SRTP** | Voice/video calls (always E2EE) |
| **VAPID / Web Push** | Background push notifications |
| **TOTP RFC 6238** | Two-factor authentication |
| **WebAuthn** | Hardware key vault unlock (infrastructure ready) |
| **WebM/Opus** | Voice message codec |
| **Background Sync API** | Offline message outbox replay |

---

## Architecture Diagram

```
                         ┌──────────────────────────────────────────────────────────────┐
                         │                    DOCKER HOST (VPS)                          │
                         │                                                              │
    ┌──────────┐   HTTPS │   ┌────────────────────────────────────────────────────┐     │
    │          │ ◄──────►│   │  Caddy :80/:443  (auto TLS via Let's Encrypt)      │     │
    │  Browser │         │   │                                                    │     │
    │ (Client) │         │   │  onetothree.ru      ──► web:3000   (Next.js)       │     │
    │          │         │   │  api.onetothree.ru   ──► api:8080  (Fastify)       │     │
    └────┬─────┘         │   │  s3.onetothree.ru    ──► minio:9000(MinIO)         │     │
         │               │   └────────────────────────────────────────────────────┘     │
         │               │                                                              │
         │  WebSocket    │   ┌────────────┐      ┌──────────────┐                       │
         │  (wss://)     │   │  Fastify   │◄────►│  PostgreSQL  │  (encrypted blobs,    │
         │ ──────────────┤──►│  API :8080 │      │  :5432       │   public keys,        │
         │               │   │            │◄──┐  └──────────────┘   usernames,          │
         │               │   └────────────┘   │                     timestamps)         │
         │               │         │          │  ┌──────────────┐                       │
         │  PUT/GET      │         │          └─►│  Redis       │  (optional:           │
         │  presigned    │         │             │  :6379       │   QR tokens,          │
         │ ──────────────┤──►┌─────┴──────┐     └──────────────┘   multi-node)         │
         │               │   │   MinIO    │                                             │
         │               │   │   :9000    │  ← encrypted media blobs (AES-GCM-256)     │
         │               │   └────────────┘                                             │
         │               │                                                              │
         │  UDP/TCP      │   ┌────────────────────────────────────────────┐             │
         │  TURN relay   │   │  coturn :3478 (host networking)            │             │
         │ ──────────────┤──►│  UDP relay :49152-65535                    │             │
         │               │   │  realm: onetothree.ru                      │             │
         │               │   └────────────────────────────────────────────┘             │
         │               └──────────────────────────────────────────────────────────────┘
         │
         │  Peer-to-peer (when possible)
         │  ┌──────────┐
         └─►│ Browser  │  ◄── DTLS-SRTP encrypted audio/video
            │ (Peer)   │      (server never sees call content)
            └──────────┘
```

### What Runs Where

```
┌─────────────────────────────────────────────┐
│                 CLIENT (Browser)             │
│                                             │
│  ◆ All encryption / decryption              │
│  ◆ Private key generation & storage         │
│  ◆ Vault lock/unlock (PBKDF2 + AES-GCM)    │
│  ◆ Message encrypt before send              │
│  ◆ Media encrypt before upload              │
│  ◆ WebRTC peer connection (calls)           │
│  ◆ IndexedDB caches (messages, media)       │
│  ◆ Group key wrapping per member            │
│  ◆ Trust verification (safety numbers)      │
│  ◆ Web Worker batch decryption              │
│  ◆ Service Worker (push, offline outbox)    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│                 SERVER (API)                 │
│                                             │
│  ◆ Store & forward encrypted blobs          │
│  ◆ User registration (public keys only)     │
│  ◆ Challenge-response auth verification     │
│  ◆ WebSocket message relay                  │
│  ◆ WebRTC signal relay (offer/answer/ICE)   │
│  ◆ Presigned S3 URL generation              │
│  ◆ Push notification dispatch               │
│  ◆ Rate limiting & access control           │
│  ◆ Read receipt & delivery tracking         │
│  ◆ TOTP 2FA verification                   │
│  ◇ NEVER: decrypt content, see keys, read   │
│    messages, access media plaintext          │
└─────────────────────────────────────────────┘
```

---

## Cryptographic Architecture

### Authentication — ECDSA P-256 Challenge-Response

No password is ever sent to the server. Authentication uses a digital signature scheme:

```
 Registration:                                Login:
 ────────────                                 ─────
 Client                    Server             Client                    Server
   │                         │                  │                         │
   │  generate ECDSA P-256   │                  │   read vault from       │
   │  generate ECDH  P-256   │                  │   localStorage          │
   │                         │                  │   PIN → PBKDF2 →        │
   │  POST /auth/challenge   │                  │   decrypt vault         │
   │ ───────────────────────►│                  │                         │
   │                         │                  │  POST /auth/challenge   │
   │   { nonce }             │                  │ ───────────────────────►│
   │ ◄───────────────────────│                  │                         │
   │                         │                  │   { nonce }             │
   │  sign(nonce, ecdsa_priv)│                  │ ◄───────────────────────│
   │                         │                  │                         │
   │  POST /auth/verify      │                  │  sign(nonce, ecdsa_priv)│
   │  { sig, ecdsa_pub,      │                  │                         │
   │    ecdh_pub, username }  │                  │  POST /auth/verify      │
   │ ───────────────────────►│                  │  { sig, username }      │
   │                         │                  │ ───────────────────────►│
   │  verify sig with pub    │                  │                         │
   │  store public keys      │                  │  verify sig with        │
   │  issue JWT + cookie     │                  │  stored pub key         │
   │                         │                  │  issue JWT + cookie     │
   │   { token, user }       │                  │                         │
   │ ◄───────────────────────│                  │   { token, user }       │
   │                         │                  │ ◄───────────────────────│
   │  encrypt vault:         │                  │                         │
  │  PBKDF2(pin, salt, 600k)│
   │    → AES-GCM wrap keys  │
   │  store in localStorage  │
```

**What the server stores:** ECDSA public key, ECDH public key, username
**What the server never sees:** Private keys, PIN/passphrase, vault plaintext

### Vault Encryption

The vault holds both private keys (ECDSA + ECDH) encrypted with a user-chosen PIN:

```
                         ┌──────────────────────────────────────┐
  User PIN ─────────────►│  PBKDF2                              │
                         │  • 210,000 iterations                │
  Random salt (16 B) ───►│  • SHA-256                           │
                         │  • Output: 256-bit AES key           │
                         └─────────────┬────────────────────────┘
                                       │
                                       ▼
                         ┌──────────────────────────────────────┐
  Vault payload  ───────►│  AES-GCM-256                         │
  (ECDSA priv JWK +      │  • Random 12-byte IV per seal        │
   ECDH priv JWK)        │  • Authenticated encryption          │
                         └─────────────┬────────────────────────┘
                                       │
                                       ▼
                         ┌──────────────────────────────────────┐
                         │  VaultBlob (stored in localStorage)   │
                         │  {                                    │
                         │    version: 2,                        │
                         │    saltB64:  "...",   // 16 bytes     │
                         │    ivB64:    "...",   // 12 bytes     │
                         │    ciphertextB64: "..." // sealed JWK │
                         │  }                                    │
                         └──────────────────────────────────────┘
```

**Vault V2 payload structure:**
```json
{
  "v": 2,
  "ecdsaPrivateJwk": "<JWK string — signing key>",
  "ecdhPrivateJwk":  "<JWK string — encryption key>"
}
```

### Per-Message Encryption (Direct Chats)

```
  Sender                                              Recipient
    │                                                     │
    │  ECDH(sender_priv, recipient_pub)                   │
    │  ──────────────────────────────►                     │
    │          256-bit shared secret                       │
    │                    │                                 │
    │          ┌─────────▼──────────┐                     │
    │          │ AES-GCM-256        │                     │
    │          │ • random 12-B IV   │                     │
    │          │ • encrypt plaintext│                     │
    │          └─────────┬──────────┘                     │
    │                    │                                 │
    │          { ciphertext, iv }                          │
    │  ─────── via WebSocket / REST ─────────────────────►│
    │                                                     │
    │                                    ECDH(recip_priv, sender_pub)
    │                                    same 256-bit shared secret
    │                                              │
    │                                    ┌─────────▼──────────┐
    │                                    │ AES-GCM-256        │
    │                                    │ • provided IV      │
    │                                    │ • decrypt          │
    │                                    └────────────────────┘
```

### Group Key Distribution (Sectors)

Groups use a shared symmetric key. The creator distributes it encrypted per-member:

```
  Group Creator                          Each Member
       │                                      │
       │  1. Generate random 256-bit           │
       │     AES-GCM group key                 │
       │                                       │
       │  2. For each member:                  │
       │     a. Generate ephemeral ECDH        │
       │        key pair (P-256)               │
       │     b. ECDH(ephemeral_priv,           │
       │           member_ecdh_pub)            │
       │        → 256-bit wrap key             │
       │     c. AES-GCM(wrap_key,              │
       │           group_key)                  │
       │        → encrypted_group_key          │
       │                                       │
       │  3. Send to server per member:        │
       │     {                                 │
       │       ciphertext: "...",              │
       │       iv: "...",                      │
       │       ephemeralPublicKeyJwk: "..."    │
       │     }                                 │
       │ ─────────────────────────────────────►│
       │                                       │
       │            4. Member unwraps:         │
       │               ECDH(member_priv,       │
       │                    ephemeral_pub)      │
       │               → wrap key              │
       │               AES-GCM decrypt         │
       │               → raw group key         │
       │                                       │
       │            5. Import as AES-GCM-256   │
       │               key for all group msgs  │
```

### Per-File Encryption

```
  Client (upload)                          MinIO (S3)
    │                                         │
    │  1. Derive/use chat AES key             │
    │     (ECDH for direct, group key         │
    │      for sector)                        │
    │                                         │
    │  2. Generate random 12-byte IV          │
    │                                         │
    │  3. AES-GCM-256 encrypt file            │
    │     with chat key + file IV             │
    │                                         │
    │  4. Request presigned PUT URL           │
    │     from API                            │
    │                                         │
    │  5. PUT encrypted blob ────────────────►│
    │                                         │
    │  6. Send message with:                  │
    │     media_path (S3 key)                 │
    │     media_iv (file-specific IV)         │
    │     (content encrypted separately)      │
```

### Device Linking & Key Transfer

```
  Device A (authenticated)              Device B (new)
       │                                     │
       │  POST /auth/qr-generate             │
       │  → link_token (UUID, 5-min TTL)     │
       │                                     │
       │  Display QR code ◄──── scan ────────│
       │                                     │
       │                    POST /auth/qr-login
       │                    { token, device_id,
       │                      device_name }
       │                                     │
       │              Server validates token  │
       │              Creates device session  │
       │              Returns JWT + cookie    │
       │                                     │
       │  Vault sync: encrypted blob is      │
       │  accessible from any authenticated  │
       │  device via /vault/fetch             │
       │                                     │
       │  Device B enters PIN locally to      │
       │  decrypt vault → gains both keys    │
```

### WebRTC Call Security

```
  Caller                   Server (signal relay only)              Callee
    │                              │                                  │
    │  call_invite (WS)            │                                  │
    │ ────────────────────────────►│  relay call_invite ──────────────►│
    │                              │                                  │
    │                              │  ◄────── webrtc_signal (answer)  │
    │  ◄── relay webrtc_signal ────│                                  │
    │                              │                                  │
    │  ◄─── ICE candidates ────────│────── ICE candidates ───────────►│
    │                              │                                  │
    │  ════════════════════════════════════════════════════════════════│
    │           DTLS-SRTP encrypted media (peer-to-peer)              │
    │           Server NEVER sees audio or video                      │
    │  ════════════════════════════════════════════════════════════════│
    │                              │                                  │
    │  (If NAT blocks P2P:)        │                                  │
    │  ═══ TURN relay via coturn ══╪═══════════════════════════════════│
    │      (still DTLS-SRTP —      │  coturn relays encrypted UDP     │
    │       coturn sees only       │  but cannot decrypt SRTP)        │
    │       encrypted packets)     │                                  │
```

### Cryptographic Parameter Summary

| Parameter | Value |
|---|---|
| Symmetric cipher | AES-GCM-256 (256-bit key, 12-byte IV, 128-bit auth tag) |
| Key agreement | ECDH P-256 |
| Authentication | ECDSA P-256 + SHA-256 |
| Vault KDF | PBKDF2-SHA-256, 210,000 iterations, 16-byte random salt |
| Group key wrap | Ephemeral ECDH → AES-GCM-256 per member |
| Call encryption | DTLS-SRTP (WebRTC standard — always E2EE) |
| Key fingerprint | SHA-256 of canonicalized JWK → 6-block safety number |
| TOTP | HMAC-SHA1, 6 digits, 30-second step (RFC 6238) |

---

## Security Audit

**Last audited:** April 2026

### Cryptographic Strengths
- ✅ Exclusive Web Crypto API (no JS crypto libraries)
- ✅ AES-256-GCM with random 12-byte IVs, no IV reuse
- ✅ ECDSA P-256 challenge-response (password never sent to server)
- ✅ Per-file encryption keys (compromise of one file doesn't expose others)
- ✅ PBKDF2-SHA256 with 600,000 iterations (updated from 210k)
- ✅ Parameterized SQL via Drizzle ORM (no SQL injection)
- ✅ httpOnly, Secure, SameSite=Strict cookies
- ✅ HSTS with preload, 2-year max-age

### Mitigated Issues (fixed)
- ✅ JWT server-side revocation via jti denylist
- ✅ Vault PIN change mechanism
- ✅ CSP unsafe-eval removed from production
- ✅ PBKDF2 iterations increased to 600k
- ✅ Session lifetime reduced to 24h sliding window
- ✅ TOTP secret only persisted after successful verification
- ✅ Permissions-Policy allows camera/mic for WebRTC

### Known Limitations
- Vault stored in localStorage (mitigated by AES-256-GCM encryption)
- Background Sync not supported on iOS Safari
- WebAuthn largeBlob not universally supported (fallback to PRF extension)

---

## Feature Implementation Map

| Feature | Client | Server | Protocol / Standard |
|---|---|---|---|
| **E2EE Direct Messaging** | `lib/crypto.ts`, `lib/chat-crypto.ts`, `workers/crypto.worker.ts` | `routes/messages.ts`, `routes/ws.ts` | AES-GCM-256, ECDH P-256, WebSocket |
| **E2EE Group Messaging** | `lib/chat-logic.ts`, `hooks/use-group-key-distribution.ts` | `routes/chats.ts`, `routes/messages.ts` | AES-GCM-256, ephemeral ECDH wrapping |
| **Voice Messages** | `components/chat/chat-input.tsx`, `hooks/use-media-recorder.ts` | `routes/storage.ts`, `routes/messages.ts` | WebM/Opus, AES-GCM-256, MinIO |
| **Video Circles** | `components/chat/secure-video-circle.tsx`, `hooks/use-media-recorder.ts` | `routes/storage.ts` | WebM, circular CSS, E2EE |
| **Voice/Video Calls** | `hooks/use-webrtc.ts`, `components/call/active-call-overlay.tsx` | `routes/ws.ts` (signal relay) | WebRTC, DTLS-SRTP, ICE/TURN |
| **Screen Share** | `hooks/use-webrtc.ts` (track replacement) | `routes/ws.ts` | WebRTC getDisplayMedia |
| **File Sharing** | `hooks/use-send-media.ts`, `lib/media-crypto.ts` | `routes/storage.ts` (presigned URLs) | AES-GCM-256, S3 PUT/GET |
| **Push Notifications** | `lib/push-subscription.ts`, `hooks/use-phantom-push.ts` | `routes/push.ts`, `lib/push.ts` | VAPID, Web Push API |
| **2FA (TOTP)** | `components/settings-modal.tsx` | `routes/auth.ts` | TOTP RFC 6238 (otplib) |
| **Multi-Device** | `components/settings-devices-panel.tsx`, `components/settings-link-device-modal.tsx` | `routes/auth.ts`, `lib/qr-link-store.ts`, `routes/devices.ts` | QR linking, vault sync, key re-wrapping |
| **Vault Encryption** | `lib/vault.ts`, `lib/vault-keyring.ts` | `routes/vault.ts` | PBKDF2 210k + AES-GCM-256 |
| **Passwordless Auth** | `lib/auth/crypto-login.ts` | `routes/auth.ts`, `lib/ecdsa-verify.ts`, `lib/challenge-store.ts` | ECDSA P-256 challenge-response |
| **Read Receipts** | `hooks/use-read-receipts.ts` | `routes/messages.ts` (direct chats only) | WebSocket `message_read` |
| **Typing Indicators** | `hooks/use-typing-indicator.ts` | `routes/ws.ts` | WebSocket `typing_start/stop` |
| **Presence / Online** | `hooks/use-presence-sync.ts` | `routes/users.ts`, `lib/presence.ts` | WebSocket `presence_ping` |
| **Offline Outbox** | `lib/outbox.ts`, `hooks/use-message-delivery-sync.ts` | `routes/messages.ts` (`/sync/pending`) | IndexedDB (Dexie), Background Sync API |
| **Message Burn** | Chat UI (timer display) | `routes/messages.ts` (burn_at field) | Server stores timestamp, client enforces |
| **User Profiles** | `components/user-profile-modal.tsx` | `routes/users.ts` | Bio, status, social links, avatar |
| **Avatar Upload** | `components/settings-avatar-section.tsx` | `routes/users.ts` (nonce + presigned) | S3, nonce-based validation |
| **Admin Panel** | `app/admin/page.tsx` | `routes/admin.ts` | System stats, ban/purge, reports |
| **i18n (EN/RU)** | `locales/en.ts`, `locales/ru.ts`, `store/localeStore.ts` | — | Zustand + localStorage |
| **PWA Install** | `hooks/use-pwa-install.ts`, `app/manifest.ts`, `components/pwa-install-banner.tsx` | — | Web App Manifest, Service Worker |
| **Trust Verification** | `lib/trust-store.ts`, `lib/crypto.ts` (safety numbers) | — | SHA-256 key fingerprint comparison |
| **WebAuthn** | `lib/webauthn-vault.ts` | — | WebAuthn (infrastructure ready) |
| **Invite Links** | `app/join/[code]/page.tsx` | `routes/chats.ts` (`/invite`, `/join/:code`) | One-time or persistent codes |

---

## Data Flow — What the Server Sees

This is the most important section. OneToThree operates on a **zero-trust server** model:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SERVER STORES                                     │
│                                                                             │
│  ✅ Encrypted message blobs     (AES-GCM ciphertext + IV — cannot decrypt)  │
│  ✅ Encrypted media blobs       (AES-GCM ciphertext — stored in MinIO)      │
│  ✅ Encrypted vault backup      (PBKDF2-wrapped — server cannot unlock)     │
│  ✅ Encrypted group keys        (per-member ECDH-wrapped — server has no    │
│                                  private keys to unwrap)                    │
│  ✅ ECDSA public keys           (for challenge verification only)           │
│  ✅ ECDH public keys            (for key agreement — useless without priv)  │
│  ✅ Usernames                   (chosen by user — no phone, no email req'd) │
│  ✅ Timestamps                  (message created_at, last_seen)             │
│  ✅ Chat membership             (who is in which chat — not what they said) │
│  ✅ Device sessions             (device name, last activity)                │
│  ✅ Push subscription endpoints (for notification delivery)                 │
│  ✅ Delivery receipts           (message was delivered — not its content)   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                      SERVER NEVER SEES                                      │
│                                                                             │
│  ❌ Message plaintext           (encrypted before leaving browser)          │
│  ❌ Media content               (encrypted before upload to S3)             │
│  ❌ Private keys                (generated and stored only in browser)      │
│  ❌ Vault passphrase / PIN      (PBKDF2 derivation happens in browser)      │
│  ❌ Group key plaintext         (ECDH unwrapping happens in browser)        │
│  ❌ Call audio / video           (DTLS-SRTP — peer-to-peer or via TURN,     │
│                                  but always encrypted end-to-end)           │
│  ❌ Key fingerprints / safety #  (computed locally from public keys)        │
│  ❌ Decrypted cached messages    (IndexedDB is browser-local)              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### If the Server is Compromised

An attacker who gains full database access obtains:

| Data | Useful to attacker? |
|---|---|
| Messages table | **No** — AES-GCM-256 ciphertext, no key |
| Media in MinIO | **No** — AES-GCM-256 encrypted blobs |
| Vault backups | **No** — PBKDF2 (600k iter) + AES-GCM-256, needs user PIN |
| Public keys | **No** — cannot derive private keys from public keys |
| Group key payloads | **No** — ECDH-wrapped, needs member private key |
| Usernames | **Yes** — usernames are plaintext |
| Timestamps | **Yes** — when messages were sent |
| Chat membership | **Yes** — who talks to whom (metadata) |
| Push endpoints | **Yes** — could send fake push notifications |

**Bottom line:** Content confidentiality is preserved even under full server compromise. Only metadata (who, when, which chat) is exposed.

---

## Infrastructure

### Docker Compose Services (Production)

```
docker-compose.prod.yml — 7 services
═══════════════════════════════════════

  ┌─────────┐     ┌─────────┐     ┌─────────────┐
  │  caddy   │────►│   web   │     │  db-migrate  │ (one-shot: runs Drizzle
  │ :80/:443 │     │  :3000  │     │              │  migrations, then exits)
  │          │     │ Next.js │     └──────┬───────┘
  │          │────►│standalone│            │
  │          │     └─────────┘            ▼
  │          │                     ┌─────────────┐
  │          │────►┌─────────┐────►│ PostgreSQL   │ pgdata volume
  │          │     │   api   │     │ :5432        │
  │          │     │  :8080  │     └─────────────┘
  │          │     │ Fastify │
  │          │     │ read_only│───►┌─────────────┐
  │          │────►│  tmpfs  │    │   MinIO      │ minio_data volume
  └─────────┘     └─────────┘    │   :9000      │
                                  └─────────────┘
  ┌────────────────────────────────────────────┐
  │  coturn (host networking)                   │
  │  :3478 TCP+UDP, :49152-65535 UDP            │
  │  lt-cred-mech, realm=onetothree.ru         │
  └────────────────────────────────────────────┘
```

### Service Details

| Service | Image | Resources | Health Check |
|---|---|---|---|
| **db** | `postgres:alpine` | 1 CPU, 512 MB | `pg_isready` every 5s |
| **minio** | `minio/minio:latest` | 2 CPU, 512 MB | `mc ready local` every 5s |
| **db-migrate** | Custom (node:20-alpine) | 0.25 CPU share | Runs once, exits |
| **api** | Custom (node:20-alpine) | 4 CPU, 1 GB, read-only fs | `GET /health` every 10s |
| **web** | Custom (node:20-alpine) | 4 CPU, 1.5 GB | `GET /` every 15s |
| **coturn** | `coturn/coturn:4.6` | Host networking | — |
| **caddy** | `caddy:2-alpine` | 1 CPU, 256 MB | — |

### Volume Persistence

| Volume | Service | Content |
|---|---|---|
| `pgdata` | PostgreSQL | All database state |
| `minio_data` | MinIO | Encrypted media files |
| `caddy_data` | Caddy | TLS certificates (Let's Encrypt) |
| `caddy_config` | Caddy | Auto-generated config |

### Security Hardening

- **API container:** `read_only: true` filesystem with restricted tmpfs (`noexec`, `nosuid`, `nodev`, 128 MB)
- **Non-root containers:** API runs as `app` (uid 1001), web runs as `nextjs` (uid 1001)
- **Caddy headers:** HSTS (2 years, preload), X-Frame-Options DENY, nosniff, strict referrer, permissions policy
- **Rate limiting:** Fastify rate-limit on auth endpoints (10 attempts/minute for 2FA)
- **DNS pinning:** All containers resolve `*.onetothree.ru` to host-gateway

### start.sh — Production Launcher

```
./start.sh              Build and start all services
./start.sh stop         Stop all containers
./start.sh restart      Restart without rebuild
./start.sh logs         Tail logs from all services
./start.sh status       Show container health status
./start.sh update       git pull + rebuild + restart
./start.sh backup       Backup PostgreSQL (gzipped SQL)
```

**First-run automation:**
- Generates `JWT_SECRET` and `WEBHOOK_SECRET` (random hex)
- Generates VAPID key pair (via `npx web-push generate-vapid-keys`)
- Syncs `DATABASE_URL` from `POSTGRES_*` variables
- Syncs `NEXT_PUBLIC_TURN_*` from `TURN_*` variables
- Validates required fields before starting

---

## Self-Hosting Guide

### Hardware Requirements

| Component | Minimum | Recommended |
|---|---|---|
| CPU | 2 cores | 4 cores |
| RAM | 4 GB | 6+ GB |
| Disk | 20 GB SSD | 50+ GB SSD (media storage) |
| Network | 100 Mbps | 1 Gbps (for video calls) |
| OS | Any Linux with Docker | Ubuntu 22.04 / Debian 12 |

### Required Open Ports

| Port | Protocol | Service | Notes |
|---|---|---|---|
| **80** | TCP | Caddy | HTTP → HTTPS redirect + ACME challenge |
| **443** | TCP | Caddy | HTTPS — all web traffic |
| **3478** | TCP + UDP | coturn | TURN/STUN signaling |
| **49152–65535** | UDP | coturn | TURN media relay range |

```bash
# UFW firewall example
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49152:65535/udp
```

### DNS Setup

Create these DNS records pointing to your server IP:

| Record | Type | Value | Proxy |
|---|---|---|---|
| `yourdomain.com` | A | `<server IP>` | Cloudflare OK (orange) |
| `api.yourdomain.com` | A | `<server IP>` | Cloudflare OK (orange) |
| `s3.yourdomain.com` | A | `<server IP>` | Cloudflare OK (orange) |
| `turn.yourdomain.com` | A | `<server IP>` | **DNS only (gray cloud!)** |

### Cloudflare Configuration

> **CRITICAL:** The TURN hostname (`turn.yourdomain.com`) **MUST** be set to
> "DNS only" (gray cloud). Cloudflare's orange-cloud proxy does **not** support
> the UDP traffic that TURN requires. Voice and video calls will fail silently
> if TURN is behind the proxy.

- `yourdomain.com` — can be proxied (orange cloud) ✅
- `api.yourdomain.com` — can be proxied (orange cloud) ✅ (WebSocket works through CF)
- `s3.yourdomain.com` — can be proxied (orange cloud) ✅
- `turn.yourdomain.com` — **MUST be DNS only** (gray cloud) ⚠️

### Quick Start

```bash
# 1. Clone
git clone https://github.com/user/OneToThree.git
cd OneToThree

# 2. Configure
cp .env.prod.example .env.prod
# Edit .env.prod — fill in 6 required fields:
#   POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD,
#   TURN_EXTERNAL_IP, TURN_PASSWORD,
#   CORS_ORIGIN (your domain), VAPID_SUBJECT (your email)

# 3. Launch
./start.sh
# Generates JWT_SECRET, WEBHOOK_SECRET, VAPID keys automatically
# Runs migrations, builds containers, starts everything

# 4. Verify
./start.sh status
# All services should show "healthy"
```

### Environment Variables

| Variable | Auto-generated? | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | No | Database password |
| `MINIO_ROOT_PASSWORD` | No | S3 storage password |
| `TURN_EXTERNAL_IP` | No | Server public IP (`curl -s ifconfig.me`) |
| `TURN_PASSWORD` | No | TURN relay credential |
| `CORS_ORIGIN` | No | Your domain (e.g., `https://yourdomain.com`) |
| `VAPID_SUBJECT` | No | Email for push (e.g., `mailto:you@domain.com`) |
| `JWT_SECRET` | **Yes** | Session signing key |
| `WEBHOOK_SECRET` | **Yes** | Internal webhook auth |
| `VAPID_PUBLIC_KEY` | **Yes** | Push notification public key |
| `VAPID_PRIVATE_KEY` | **Yes** | Push notification private key |
| `DATABASE_URL` | **Yes** | Synced from POSTGRES_* |
| `NEXT_PUBLIC_TURN_*` | **Yes** | Synced from TURN_* |

---

## Roadmap

### Shipped (Current State)

- [x] E2EE direct messaging (AES-GCM-256 + ECDH P-256)
- [x] E2EE group messaging with key distribution
- [x] Voice messages (WebM/Opus, encrypted)
- [x] Video circles (encrypted, circular UI)
- [x] Voice and video calls (WebRTC, DTLS-SRTP)
- [x] Screen sharing in calls
- [x] Encrypted file sharing (per-file key, MinIO)
- [x] Push notifications (VAPID/Web Push)
- [x] 2FA / TOTP (RFC 6238)
- [x] Multi-device with QR linking
- [x] Passwordless auth (ECDSA challenge-response)
- [x] Vault encryption (PBKDF2 600k + AES-GCM)
- [x] Offline outbox (IndexedDB queue)
- [x] Read receipts (direct chats)
- [x] Typing indicators
- [x] Online presence tracking
- [x] Message burn (timed deletion)
- [x] Reply-to messages
- [x] User profiles (bio, status, social links)
- [x] Admin panel (stats, ban, purge)
- [x] PWA support (installable, offline-capable)
- [x] i18n (English + Russian)
- [x] Safety numbers (key fingerprint verification)
- [x] Trust pinning with compromise detection
- [x] Device re-authorization for revoked devices
- [x] Next/prev voice message navigation
- [x] Swipe-to-lock recording (voice + circles)
- [x] Background Sync service worker for offline queue

### In Progress / Planned

- [ ] **WebAuthn vault unlock** — infrastructure exists (`webauthn-vault.ts`), not yet wired to UI
- [ ] **Sticker support** — locale strings exist, implementation pending
- [ ] **Social links API** — user profile supports `social_links` field, frontend rendering partial
- [ ] **Media retention purge** — `media-retention-purge.ts` exists, needs scheduling/config
- [ ] **Redis-backed multi-node** — QR store supports Redis, full horizontal scaling untested
- [ ] **Group admin permissions** — role system exists (owner/admin/member), granular permissions TBD

---

## WebSocket Protocol Reference

### Client → Server Messages

| Type | Payload | Purpose |
|---|---|---|
| `chat_message` | `chat_id, content, iv, media_path?, media_type?, media_iv?, reply_to_id?, burn_at?` | Send encrypted message |
| `webrtc_signal` | `targetUserId, signalData` | WebRTC offer/answer/ICE/media_state |
| `call_invite` | `chat_id, is_video` | Initiate call to chat members |
| `call_leave` | `chat_id` | End call participation |
| `message_read` | `chat_id, message_id` | Read receipt (direct only) |
| `typing_start` | `chat_id` | Begin typing indicator |
| `typing_stop` | `chat_id` | End typing indicator |
| `presence_ping` | — | Heartbeat, updates last_seen |

### Server → Client Messages

| Type | Payload | Purpose |
|---|---|---|
| `chat_message` | Full message object | Incoming encrypted message |
| `chats_updated` | — | Chat list changed (new chat, member change) |
| `message_deleted` | `message_id, chat_id` | Message deleted for everyone |
| `webrtc_signal` | `fromUserId, signalData` | Relayed WebRTC signal |
| `call_invite` | `chat_id, callerId, is_video` | Incoming call notification |
| `typing_start/stop` | `chat_id, user_id` | Typing indicator relay |

---

## Database Schema

```
┌──────────────────────┐       ┌──────────────────────┐
│       users           │       │       chats           │
├──────────────────────┤       ├──────────────────────┤
│ id             UUID   │       │ id             UUID   │
│ username       TEXT   │──┐    │ type           TEXT   │
│ publicKeyJwk   TEXT   │  │    │ name           TEXT   │
│ ecdhPublicKeyJwk TEXT │  │    │ created_by     UUID   │
│ vaultBlob      TEXT   │  │    │ invite_code    TEXT   │
│ role           TEXT   │  │    │ created_at     TS     │
│ totp_secret    TEXT   │  │    └──────────┬───────────┘
│ avatar_key     TEXT   │  │               │
│ bio            TEXT   │  │    ┌──────────┴───────────┐
│ status_text    TEXT   │  │    │    chatMembers        │
│ social_links   JSON   │  │    ├──────────────────────┤
│ is_discoverable BOOL  │  ├───►│ user_id        UUID   │
│ hide_presence   BOOL  │  │    │ chat_id        UUID   │
│ banned         BOOL   │  │    │ role           TEXT   │
│ created_at     TS     │  │    │ encryptedGroupKey TEXT│
└──────────────────────┘  │    │ joined_at      TS     │
                           │    └──────────────────────┘
┌──────────────────────┐  │
│      devices          │  │    ┌──────────────────────┐
├──────────────────────┤  │    │      messages          │
│ id             UUID   │  │    ├──────────────────────┤
│ user_id        UUID   │◄─┤    │ id             UUID   │
│ device_name    TEXT   │  │    │ chat_id        UUID   │
│ clientDeviceKey TEXT  │  │    │ sender_id      UUID   │
│ is_master      BOOL   │  │    │ content        TEXT   │ ← ciphertext
│ revoked        BOOL   │  │    │ iv             TEXT   │
│ last_activity  TS     │  │    │ media_path     TEXT   │
│ created_at     TS     │  │    │ media_type     TEXT   │
└──────────────────────┘  │    │ media_iv       TEXT   │
                           │    │ reply_to_id    UUID   │
┌──────────────────────┐  │    │ burn_at        TS     │
│  pushSubscriptions    │  │    │ created_at     TS     │
├──────────────────────┤  │    └──────────────────────┘
│ id             UUID   │  │
│ user_id        UUID   │◄─┘    ┌──────────────────────┐
│ endpoint       TEXT   │       │  messageDeliveries    │
│ keys_p256dh    TEXT   │       ├──────────────────────┤
│ keys_auth      TEXT   │       │ id             UUID   │
│ created_at     TS     │       │ message_id     UUID   │
└──────────────────────┘       │ recipient_id   UUID   │
                                │ delivered      BOOL   │
                                │ read           BOOL   │
                                │ created_at     TS     │
                                └──────────────────────┘
```

---

## Project Structure

```
OneToThree/
├── client/                    # Next.js 16 frontend
│   ├── src/
│   │   ├── app/               # App Router pages
│   │   ├── components/        # React components
│   │   │   ├── auth/          # Login, register, QR
│   │   │   ├── call/          # WebRTC call UI
│   │   │   ├── chat/          # Messaging interface
│   │   │   ├── onboarding/    # First-time setup
│   │   │   └── ui/            # Shared UI primitives
│   │   ├── hooks/             # Custom React hooks
│   │   ├── lib/               # Crypto, vault, caches
│   │   ├── locales/           # i18n strings (en, ru)
│   │   ├── store/             # Zustand state stores
│   │   └── workers/           # Web Workers (crypto)
│   ├── public/                # Static assets, SW
│   ├── Dockerfile             # Production multi-stage
│   └── Dockerfile.dev         # Development
│
├── server/                    # Fastify backend
│   ├── src/
│   │   ├── routes/            # HTTP + WS endpoints
│   │   ├── ws/                # WebSocket registry
│   │   ├── lib/               # Business logic
│   │   ├── db/                # Drizzle ORM schema
│   │   └── types/             # TypeScript definitions
│   ├── drizzle/               # SQL migrations
│   ├── Dockerfile             # Production
│   └── Dockerfile.dev         # Development
│
├── docker/
│   ├── coturn/                # TURN server config
│   └── db-migrate/            # Migration container
│
├── docker-compose.yml         # Development
├── docker-compose.prod.yml    # Production (7 services)
├── Caddyfile                  # Reverse proxy + TLS
├── start.sh                   # Production launcher
├── drizzle.config.ts          # ORM config
├── .env.prod.example          # Environment template
└── FOSS.md                    # ← You are here
```

---

## Mobile Strategy

### Current: PWA (Progressive Web App)
OneToThree ships as a full-featured PWA installable on Android and iOS.

| Feature | Android Chrome | iOS Safari (16.4+) |
|---------|---------------|-------------------|
| Install to home screen | ✅ | ✅ |
| Push notifications | ✅ | ✅ |
| Background sync | ✅ | ❌ (Safari limitation) |
| Biometric unlock (WebAuthn) | ✅ | ✅ |
| Wake Lock (screen on during call) | ✅ | ❌ |
| MediaSession (lock screen controls) | ✅ | ⚠️ Partial |
| Incoming call notification actions | ✅ | ⚠️ Partial |
| Share Target | ✅ | ❌ |
| Badging API | ✅ | ✅ (16.4+) |

### PWA Implemented Features
- WebAuthn / Passkeys — fingerprint and Face ID vault unlock
- MediaSession API — lock screen call controls, headphone buttons
- Wake Lock — screen stays on during calls
- Badging API — unread count on app icon
- Auto-lock — vault locks after configurable idle timeout
- Incoming call push with Accept/Decline actions
- Share Target — receive files shared from other apps
- Screen orientation lock for video calls
- Background Sync — queued messages sent when back online
- Periodic Background Sync (Chrome) — badge updates in background

### Future: Native Apps (Roadmap)

**Option A: Capacitor (Recommended next step)**
- Wraps existing Next.js code in native WebView
- Estimated effort: 4-6 weeks
- Platforms: Android + iOS simultaneously
- Unlocks: CallKit (iOS), Foreground Service (Android), system contact picker
- Requirements: Mac for iOS builds, Apple Developer ($99/year)

**Option B: React Native**
- Full native UI rewrite with shared business logic
- Estimated effort: 4-6 months
- Best quality native experience, background calls on both platforms

**Option C: Flutter**
- Complete rewrite in Dart
- Estimated effort: 6-9 months
- Best performance, single codebase for Android + iOS + Desktop

---

## License

This project is open source. See the LICENSE file for details.

---

<div align="center">

**OneToThree** — *Your messages. Your server. Your keys.*

Built by [rudywolf](https://github.com/rudywolf)

</div>
