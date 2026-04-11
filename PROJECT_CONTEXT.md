# ForestMessenger / Project 13 — PROJECT_CONTEXT

High-density architecture snapshot for tooling and external assistants. Paths are repo-relative.

## Tech Stack Overview

- **Client:** Next.js (App Router), React, TypeScript, Zustand (`client/src/store/chatStore.ts`), Web Crypto for E2EE, WebSocket singleton (`client/src/lib/api/socket.ts`), `fetch` to Fastify API (same-origin `/api` or `NEXT_PUBLIC_API_URL`).
- **Server:** Fastify, `@fastify/websocket`, JWT session cookie + optional WS ticket, Drizzle ORM, PostgreSQL, `web-push`, AWS SDK v3 S3 client against MinIO for presigned uploads and avatars.
- **Infra:** Docker Compose (Postgres, MinIO, server, client), env-driven CORS and cookie domain.

## Database Schema (The Skeleton)

Defined in `server/src/db/schema.ts` (Drizzle / PostgreSQL).

- **`users`:** `id` (uuid PK), `username` (unique), `public_key_jwk` (ECDSA login), `ecdh_public_key_jwk` (optional until client uploads), `is_discoverable`, `role` (`user` \| `admin`), `is_banned`, TOTP fields, `vault_blob` / `vault_version`, `avatar_key`, `last_seen_at`, `created_at`.
- **`devices`:** `id`, `user_id` → users, `client_device_key`, `device_name`, `last_active`, `user_agent`, `ip_address`, `revoked_at`, `created_at`; unique `(user_id, client_device_key)`.
- **`chats`:** `id`, `name`, `type` enum (`direct_e2e` \| `group_e2e` \| `public_open`), optional `invite_code` (unique when set).
- **`chat_members`:** composite PK `(chat_id, user_id)`, `encrypted_group_key` (nullable), `role` (`owner` \| `admin` \| `member`), `joined_at`.
- **`messages`:** `id`, `chat_id` → chats, `sender_id` → users, `reply_to_id` (uuid, no FK in schema), **`content`** / **`iv`** (E2EE ciphertext + AES-GCM IV as text/base64), **`media_path`** / **`media_type`** / **`media_iv`** (encrypted blob metadata; bytes live in MinIO), `read_at` (direct read receipts), `created_at`.
- **`message_deliveries`:** composite PK `(message_id, user_id)`, `delivered_at` (nullable until recipient acknowledges). One row per recipient (excluding sender) for store-and-forward sync. Migration `server/drizzle/0009_message_deliveries.sql` backfills `delivered_at = now()` for historical rows.
- **`push_subscriptions`:** Web Push endpoints per user.

## Authentication Flow (ECDSA Challenge-Response)

- **POST `/api/auth/challenge`** (rate-limited nested plugin in `server/src/routes/auth.ts`): body `{ username }` (Zod `challengeBodySchema`). Server stores a random `nonce` per username (in-memory challenge store), returns `{ nonce }`.
- **POST `/api/auth/verify`:** body matches Zod `verifyBodySchema`: `{ username, nonce, signature, public_key_jwk? }`. Server checks pending challenge, verifies ECDSA-P256 signature over `nonce` using stored or new `public_key_jwk`, creates user on first login, issues JWT session + HTTP-only cookie, upserts device session.
- **WS ticket:** **GET `/api/auth/ws-ticket`** (authed) returns short-lived JWT with `scope: 'ws'` for cookie-less WebSocket upgrade.

## Network Transport & Offline Messaging

- **REST vs WebSocket**
  - **REST:** auth, chats, users, vault, devices, messages list (`GET /api/messages/:chatId`), media archive, message read (`POST /api/messages/read/:messageId`), **POST `/api/messages/send`** (encrypted payload persistence when WS is down), **GET `/api/messages/sync/pending?chat_id=`** (undelivered ciphertext for current user), **POST `/api/messages/delivered`** (`{ message_ids }` ack), storage presign, admin, push subscribe, etc.
  - **WebSocket `/api/ws`:** `chat_message` (same persistence as REST path via `persistChatMessageAndFanOut`), typing, read receipts (`message_read` / broadcast `message_read_update`), `webrtc_signal`, `call_invite`, `call_leave`, `message_deleted`, presence pings, `server_notice`, etc.

- **Store-and-forward**
  - Server **always** inserts opaque ciphertext into `messages` and creates **`message_deliveries`** rows for every chat member except the sender (`server/src/lib/chat-message-persist.ts`).
  - **Fan-out:** `broadcastToUsers` to all member sockets; **push** to members without an active socket (same as before).
  - **Client send path:** `sendChatMessageOverTransport` (`client/src/lib/chat-message-transport.ts`) uses WS when `getFmSocket().connected`, else **POST `/api/messages/send`**; REST response includes the created `message` so the sender can append locally without waiting for WS.
  - **Sync:** On WS reconnect and when switching chats (while connected), `useMessageDeliverySync` pulls pending rows, decrypts, appends, then acks. **GET history** (`useLoadChatMessages`) also **acks all incoming** message ids after decrypt so the pending queue does not replay already-loaded history.

## E2EE Cryptography Architecture

- **Direct chats:** ECDH (sender private × peer `ecdh_public_key_jwk` imported as SPKI) → `deriveSharedSecret` → AES-256-GCM encrypt/decrypt message string (`client/src/lib/chat-crypto.ts`, `client/src/lib/crypto.ts`).
- **Group chats:** Wrapped group key from `encrypted_group_key` on membership row → AES-256-GCM for payload using that symmetric key.
- **Encrypted wire shape (stored in DB and sent on WS/REST):** not a nested JSON “envelope type”; fields are **parallel columns / JSON keys:** `content` (base64 ciphertext string), `iv` (base64 IV), optional `media_path`, `media_type`, `media_iv`. Text uses `encryptOutboundText` / `decryptInboundText`. **Media:** file bytes encrypted client-side with a random AES-GCM key; key wrapped into JSON `AttachmentEnvelopeV1` (`client/src/lib/attachment-envelope.ts`) encrypted as **text** into `content`/`iv`; ciphertext uploaded via presigned PUT.

## WebRTC & Call Signaling

From `server/src/routes/ws.ts` and client handlers:

- **`webrtc_signal`:** `{ type, targetUserId, signalData }` — opaque relay to peer (SDP/ICE).
- **`call_invite`:** `{ type, chat_id, is_video }` — broadcast to other chat members.
- **`call_leave`:** `{ type, chat_id }`.
- Inbound variants also include **`typing_start` / `typing_stop`**, **`message_read`**, **`message_deleted`**, **`online_status_change`**, **`server_notice`**, **`message_read_update`**, **`error`**.

## Media Upload Pipeline

1. **POST `/api/storage/upload-url`** (`server/src/routes/storage.ts`) with chat membership check; server returns presigned **PUT** URL + `filePath` (MinIO key inside chat namespace).
2. Client **`fetch(uploadUrl, { method: 'PUT', body: cipherBlob, headers: { 'Content-Type': fileType } })`** (`client/src/hooks/use-send-media.ts` — `putWithRetry`); **no file bytes on WebSocket/WebRTC.**
3. Client sends **`chat_message`** (or REST `/messages/send`) with encrypted envelope in `content`/`iv`, `media_path`, `media_type`, `media_iv`.
4. **Bucket CORS:** `server/src/lib/s3.ts` `ensureBucketExists` → `PutBucketCorsCommand` with origins from **`MINIO_CORS_ORIGINS`** (comma-separated) or, if unset, **`CORS_ORIGIN`** split list, else `['*']` for local dev. Set `MINIO_CORS_ORIGINS=https://onetothree.ru` (plus API origin if browsers hit MinIO from another host) when MinIO implements PutBucketCors.

## Key Files Index

| Concern | Location |
|--------|----------|
| WS protocol | `server/src/routes/ws.ts` |
| Message REST + sync | `server/src/routes/messages.ts` |
| Persist + fan-out | `server/src/lib/chat-message-persist.ts` |
| Client send + sync hooks | `client/src/hooks/use-send-message.ts`, `use-send-media.ts`, `use-message-delivery-sync.ts`, `use-load-chat-messages.ts`, `use-chat-realtime.ts` |
| API wrappers | `client/src/lib/api/messages.ts`, `client/src/lib/chat-message-transport.ts` |
| Drizzle schema | `server/src/db/schema.ts` |
| MinIO / presign | `server/src/lib/s3.ts`, `server/src/routes/storage.ts` |
