# Project 13 Security Model

## Cryptographic primitives

- **Authentication:** ECDSA P-256 signatures over server nonce (`SHA-256`).
- **Message encryption:** AES-GCM-256 with random per-message IV.
- **Key agreement:** ECDH over NIST curves (P-256 / P-384 support).
- **Vault wrapping:** PBKDF2(SHA-256) + AES-GCM local encrypted vault storage.

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

## Operational hardening

- Fastify security headers and rate limiting enabled.
- Production CORS must be explicit (`CORS_ORIGIN` must not be `*`).
- Containers run with constrained resources and health checks.
- Session cookies use secure flags in production.

## Security caveats

- If a client device is compromised, local private keys can be exfiltrated.
- Push notifications intentionally avoid plaintext message content.
- Offline queued websocket messages are still encrypted payloads, but are stored in browser memory until sent.

## Recommended production controls

- Run behind TLS reverse proxy (nginx/caddy) with websocket upgrade headers.
- Rotate `JWT_SECRET`, VAPID keys, and MinIO credentials periodically.
- Apply DB migrations before rollout.
- Enable continuous dependency scanning in CI.

