# Project 13 — API Reference

All endpoints are prefixed with `/api`. Authentication is via `fm_session` cookie (JWT).

---

## Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/challenge` | No | Request a nonce for ECDSA challenge-response. Body: `{ username }`. Returns `{ nonce }`. |
| `POST` | `/auth/verify` | No | Submit signed nonce + public JWK. Body: `{ username, nonce, signature, public_key_jwk }`. Sets `fm_session` cookie. Returns `{ user }`. |
| `GET` | `/auth/me` | Yes | Return current session user. |
| `POST` | `/auth/ws-ticket` | Yes | Issue a short-lived JWT for WebSocket auth. Returns `{ ticket }`. |
| `POST` | `/auth/logout` | Yes | Clear session cookie. |

## Users

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/users/me/settings` | Yes | Get `{ is_discoverable }`. |
| `PATCH` | `/users/me` | Yes | Update ECDH public key and/or discoverability. Body: `{ ecdh_public_key_jwk?, is_discoverable? }`. |
| `GET` | `/users/search?q=` | No | Search discoverable users by username. |
| `POST` | `/users/lookup` | Yes | Bulk lookup by IDs. Body: `{ user_ids: string[] }`. |

## Chats

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/chats` | Yes | List user's chats with encrypted group keys. |
| `GET` | `/chats/:chatId` | Yes | Get chat details + members + ECDH public keys. |
| `POST` | `/chats` | Yes | Create chat (direct_e2e, group_e2e, public_open). |
| `POST` | `/chats/:chatId/leave` | Yes | Leave a group chat. Auto-deletes orphaned chats. |
| `DELETE` | `/chats/:chatId` | Yes | Delete chat + all messages (member only). |

## Messages

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/messages/:chatId` | Yes | Fetch encrypted message history (limit 500). |
| `DELETE` | `/messages/:messageId` | Yes | Delete message. Body: `{ for_everyone: boolean }`. |

## Storage (MinIO Presigned URLs)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/storage/upload-url` | Yes | Get presigned PUT URL. Body: `{ chatId, fileName, fileType }`. |
| `GET` | `/storage/download-url?path=` | Yes | Get presigned GET URL for encrypted blob. |

## Push

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/push/subscribe` | Yes | Register Web Push subscription. |
| `POST` | `/push/unsubscribe` | Yes | Remove subscription. |

## WebSocket Protocol

Connect: `GET /api/ws?ticket=<jwt>` (upgrade to WebSocket).

### Client → Server

| Type | Fields | Description |
|------|--------|-------------|
| `chat_message` | `chat_id, content?, iv?, media_path?, media_type?, media_iv?, reply_to_id?` | Send encrypted message. |
| `webrtc_signal` | `targetUserId, signalData` | Relay WebRTC offer/answer/ICE to peer. |
| `call_invite` | `chat_id, is_video` | Broadcast call invitation to chat members. |
| `call_leave` | `chat_id` | Notify members you left the call. |
| `message_read` | `chat_id, message_id` | Send read receipt for a message. |

### Server → Client

| Type | Fields | Description |
|------|--------|-------------|
| `chat_message` | `message { id, chat_id, sender_id, reply_to_id?, content, iv, media_*, created_at }` | Incoming message broadcast. |
| `webrtc_signal` | `fromUserId, signalData` | Relayed WebRTC signal. |
| `call_invite` | `chat_id, from_user_id, is_video` | Incoming call invitation. |
| `call_leave` | `chat_id, from_user_id` | Peer left the call. |
| `message_read` | `chat_id, message_id, reader_id` | Read receipt from peer. |
| `message_deleted` | `message_id, chat_id` | Message deleted for everyone. |
| `chats_updated` | — | Chat list changed (reload). |
| `error` | `error` | Error string. |

---

*The server is a blind router. It stores ciphertext. It routes signals. It never sees plaintext.*
