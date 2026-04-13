# Project 13 Security Model

## Cryptographic primitives

- **Authentication:** ECDSA P-256 signatures over server nonce (`SHA-256`).
- **Message encryption:** AES-GCM-256 with random per-message IV.
- **Key agreement:** ECDH over NIST curves (P-256 / P-384 support).
- **Vault wrapping:** PBKDF2(SHA-256, 600k iterations) + AES-GCM local encrypted vault storage.

## Threat model

The design assumes:

- The server and storage provider are **honest-but-curious**.
- TLS is terminated correctly in production.
- Browser device compromise can expose local keys (out of scope for server hardening).

The design protects against:

- Server-side plaintext disclosure of chat/media content.
- Credential replay without private key possession (challenge-response).
- Passive interception of websocket traffic without session credentials.

## Zero-trust guarantees

- Server receives only ciphertext and metadata.
- WebRTC signaling is relayed as opaque payloads.
- Private keys are generated and kept client-side.
- Media is encrypted before upload to MinIO.

## E2E Encryption Verification

### Key Exchange (1:1 Chats)
- ECDH P-256 key agreement derives a shared AES-256-GCM key.
- Private keys never leave the client (`CryptoKey` non-extractable where possible).
- The server stores only encrypted ciphertext and IV; it cannot derive the shared secret.
- Client maintains a trust registry (`p13_trust_registry` in localStorage) to detect MITM/key-change attacks.

### Group E2E Encryption
- A symmetric AES group key is generated client-side.
- The group key is wrapped (encrypted) per-member using ECDH-derived keys.
- Wrapped keys are stored server-side; server cannot unwrap without member private keys.
- New members receive the group key wrapped by an admin/owner.

### Vault Security
- PBKDF2 with 600,000 iterations (SHA-256) for key derivation.
- AES-GCM-256 wraps the private key material.
- Vault blob is opaque to the server; PIN/password never transmitted.
- Version tracking prevents stale vault overwrites (optimistic concurrency).

### Residual Risk
- If a client device is compromised, local private keys can be exfiltrated.
- The server can observe metadata (who talks to whom, message sizes, timing).
- No forward secrecy (compromise of long-term ECDH key exposes past messages).

## Operational hardening

- Fastify security headers (Helmet) and rate limiting enabled.
- Production CORS must be explicit (`CORS_ORIGIN` must not be `*`).
- Containers run with constrained resources and health checks.
- Session cookies use Secure, HttpOnly, SameSite flags in production.

## Security audit findings (2026-04-13)

### Input Validation & Sanitization
- **Status:** All API endpoints validated with Zod schemas, including path parameters (UUID validation via `uuidSchema`).
- **Fix applied:** File upload names are now sanitized (strip path traversal `..`, null bytes, control characters, limit to 255 chars).
- **Fix applied:** File uploads enforce an extension allowlist (images, video, audio, documents, archives) and MIME type prefix validation.
- **Fix applied:** Server-side file size enforcement (100 MiB max) via `fileSize` field on upload-url endpoint.
- **Fix applied:** DOMPurify added as defence-in-depth for client-side UGC rendering (bio, messages, social links).
- **Fix applied:** URL protocol validation on social links (allow only http/https/mailto).
- **Residual risk:** Client-provided MIME types can be spoofed; server trusts the Content-Type header from presigned PUT. MinIO serves files from an isolated domain (`s3.onetothree.ru`) which mitigates script execution.
- **Note:** The frontend already avoids `dangerouslySetInnerHTML` — all user content is rendered via safe React text nodes and components. DOMPurify is an additional safety layer.

### Rate Limiting
- **Global:** 100 requests/minute per IP (Fastify rate-limit plugin).
- **Auth challenge/verify:** 5 per 15 minutes per IP (covers login + registration).
- **Auth QR endpoints:** 10/minute each.
- **TOTP endpoints (setup, verify, disable, login):** 5/hour each.
- **Message send (REST):** 30/minute per user.
- **File upload:** 10/minute per user.
- **Push subscribe:** 10/minute per user.
- **WebSocket messages:** 60/minute per connection (sliding window).

### Authentication Security
- **JWT claims:** `sub`, `username`, `device_id`, `jti`, `iss` (issuer: `onetothree`), `iat`, `exp`. Issuer verified on decode.
- **Token revocation:** JTI-based denylist (in-memory, with auto-cleanup of expired entries).
- **Refresh token rotation:** `POST /api/auth/refresh` issues a new JWT with fresh JTI and invalidates the old token's JTI on the denylist.
- **Device tracking:** Per-browser stable ID (`X-Client-Device-Id`), revoked devices rejected on every authenticated request.
- **Timing-safe comparison:** Nonce and public key comparisons use `crypto.timingSafeEqual`.
- **TOTP replay guard:** Each 6-digit code can only be used once within 60s window.
- **Password hashing:** N/A — authentication is ECDSA signature-based (no passwords stored server-side).

### Session Management
- **Active sessions list:** `GET /users/me/sessions` returns all device sessions with IP, user agent, last active, created_at, revocation status, and current session flag.
- **Revoke individual session:** `DELETE /users/me/sessions/:sessionId` revokes a single session by device ID and notifies via WebSocket.
- **Revoke all other sessions:** `DELETE /users/me/sessions` revokes all sessions except the current device.
- **Login history:** Audit trail in `login_events` table (IP, user agent, outcome, timestamp). Last 20 events exposed via `GET /users/me/login-history`.
- **Frontend:** Login history (last 10 events) and active sessions list with revocation available in Settings → Security / Devices tabs.

### Encryption Key Management
- **Vault key:** Never leaves the client. PBKDF2-derived AES key wraps ECDSA/ECDH private keys.
- **Private key:** Stored encrypted in localStorage vault blob; also synced to server as opaque encrypted data.
- **IndexedDB:** Media cache (Dexie) stores decrypted blobs; cleared on logout via `wipeAllClientLocalState()`.
- **Fix applied:** Logout now calls `wipeAllClientLocalState()` to clear all IndexedDB databases (media cache, message cache, WebAuthn metadata), localStorage, and sessionStorage.
- **Zustand state:** `unwrappedPrivateKey` held only in volatile memory (chat store); cleared on logout/auto-lock.
- **No private key leakage:** Reviewed all API calls — no endpoint sends private key material to the server.

### User Blocking
- **Block system:** `user_blocks` table with bidirectional enforcement.
- **API:** `POST/DELETE /users/me/block/:targetId`, `GET /users/me/blocked`.
- **Fix applied:** Block checks now enforced at message send — both WebSocket `chat_message` and REST `POST /messages/send` check `isBlocked()` for direct chats before allowing message delivery.
- **Fix applied:** Block checks enforced at chat creation — `POST /chats` checks `isBlocked()` between creator and all members for both `direct_e2e` and `group_e2e` chat types.
- **Enforcement points:** Block checks applied at message send, chat creation, group invite, and presence lookup (helper: `isBlocked()` in `block-check.ts`).
- **Frontend:** Blocked users list with unblock action available in Settings → Security tab.

### Privacy Controls
- **Read receipts toggle:** `disable_read_receipts` field on users table. When enabled, read receipt processing silently skips (no DB write, no sender notification).
- **Online status visibility:** `hide_presence` field on users table. When enabled, peers see offline status and no last-seen timestamp.
- **API:** Both settings controllable via `PATCH /users/me` and visible in `GET /users/me/settings`.
- **Frontend:** Read receipts toggle available in Settings → Security tab. Online status toggle on the main settings tab.

### Account Deletion
- **Endpoint:** `DELETE /users/me/account` with username confirmation.
- **Fix applied:** Messages are now anonymized (content → "[deleted]", media references cleared) instead of cascade-deleted.
- **Fix applied:** User's media files are deleted from MinIO (best-effort).
- **Fix applied:** User's avatar is deleted from MinIO.
- **Fix applied:** Push subscriptions are now deleted during account deletion (previously orphaned).
- **Scope:** Deletes user, all devices, push subscriptions, block records. Messages remain with anonymized content.

### File Upload Security
- **Presigned URL pattern:** Browser uploads directly to MinIO via presigned PUT; server never handles file bytes.
- **Path validation:** Strict regex enforces `chats/{chatId}/{userId}/{uuid}.ext` format.
- **Extension allowlist:** Only common image, video, audio, document, and archive extensions permitted.
- **MIME validation:** Server validates Content-Type prefix against allowed list.
- **File size limit:** 100 MiB maximum enforced server-side.
- **Isolated serving:** Files served from `s3.onetothree.ru` (separate domain from app) to prevent script execution in app context.
- **Virus scanning:** Not implemented. ClamAV can be added as a MinIO post-upload webhook if available.

### WebSocket Security
- **Authentication:** WS connections require valid JWT (session cookie or `?ticket=` query param with `scope: 'ws'`).
- **Message size limit:** 64 KB per WebSocket frame.
- **Per-connection rate limiting:** 60 messages/minute sliding window. Exceeding returns error without disconnection.
- **Device validation:** WS ticket includes `device_id`; revoked devices are rejected during handshake.
- **Fix applied:** Session revocation check on every heartbeat (presence_ping ~30s): checks JTI denylist and device revocation status. Revoked sessions are closed with code 1008.

### Dependency Audit (2026-04-13)
- **Server (`npm audit`):** 0 vulnerabilities.
- **Client (`npm audit`):** 0 vulnerabilities.
- **Root (`npm audit`):** 4 moderate severity — all in `esbuild` via `drizzle-kit` (dev dependency, migration CLI only). Not exploitable at runtime. Fix requires breaking drizzle-kit upgrade.
- **Unfixable:** `esbuild <=0.24.2` (GHSA-67mh-4wv8-2f99) — moderate severity, development server request relay. Only affects `drizzle-kit` CLI (migration tool), never runs in production. Blocked by breaking change in drizzle-kit.

## Security caveats

- If a client device is compromised, local private keys can be exfiltrated.
- Push notifications intentionally avoid plaintext message content.
- Offline queued websocket messages are still encrypted payloads, but are stored in browser memory until sent.
- No forward secrecy — compromised long-term ECDH key exposes historical messages.
- Metadata (who messages whom, timing, sizes) is observable by the server.
- JTI denylist is in-memory; it resets on server restart. For production, consider Redis-backed denylist.

## Recommended production controls

- Run behind TLS reverse proxy (nginx/caddy) with websocket upgrade headers.
- Rotate `JWT_SECRET`, VAPID keys, and MinIO credentials periodically.
- Apply DB migrations before rollout.
- Enable continuous dependency scanning in CI.
- Consider adding ClamAV scanning for uploaded files via MinIO webhook.
- Monitor `login_events` table for brute-force patterns.
- Implement login event cleanup cron (retain 90 days).
- Consider migrating JTI denylist to Redis for persistence across restarts.
- Implement client-side periodic token refresh using `POST /api/auth/refresh`.
