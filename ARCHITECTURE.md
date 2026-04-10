# Project 13 Architecture

## Monorepo layout

- `client/`: Next.js PWA UI, local cryptography, WebRTC, websocket client.
- `server/`: Fastify API, websocket relay, Drizzle ORM, S3 presign endpoints.
- `server/drizzle/`: SQL migrations.
- `docker-compose.yml`: local production-like stack (Postgres + MinIO + API + Web).

## Runtime data flow

1. User authenticates with challenge-response:
   - Server issues nonce.
   - Client signs nonce with local ECDSA private key.
   - Server verifies signature against stored public JWK.
2. Session is represented by `fm_session` cookie.
3. Client opens websocket to `/api/ws` (cookie or ws ticket JWT fallback).
4. Messages are encrypted client-side (ECDH -> AES-GCM) before `chat_message`.
5. Media payloads are encrypted client-side and uploaded to MinIO via presigned PUT URL.
6. Server routes opaque ciphertext payloads and webrtc signaling to recipients.

## Challenge-response sequence (condensed)

1. `POST /api/auth/challenge` -> `{ nonce }`
2. Client signs nonce with ECDSA P-256 private key in local vault.
3. `POST /api/auth/verify` -> server verifies signature and sets `fm_session`.
4. Future API and WS requests are authorized by session cookie (or ws ticket).

## WebRTC full mesh signaling

- Clients exchange `offer`, `answer`, and `ice` through websocket relay (`webrtc_signal`).
- Server does not parse SDP/ICE semantics; it only relays targeted payloads.
- Each call participant creates peer connections to active peers (mesh topology).

## Security boundaries

- Private keys never leave browser vault.
- Server stores public keys, encrypted messages, encrypted media metadata.
- MinIO stores ciphertext blobs only.
- Search over message text is local client-side only.

