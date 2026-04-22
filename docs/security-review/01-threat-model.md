# OneToThree Threat Model (Full Scope)

## Scope

This review covers the full monorepo:
- `client/` (crypto, vault, ratchet, transport, auth UI/session handling)
- `server/` (auth/session, keys directory, messaging, WebSocket, storage)
- deployment/security controls (`docker-compose*.yml`, `Caddyfile`, CI checks)

## Trust Boundaries

1. Browser runtime boundary (`client/src/lib/*`)
2. API boundary (`server/src/routes/*`)
3. WebSocket boundary (`server/src/routes/ws.ts`)
4. Persistence boundary (Postgres + Redis + MinIO)
5. Infra boundary (reverse proxy, secrets, env/secret files)

## Security-Critical Assets

- Session token/cookie (`fm_session`, JWT `jti`, `device_id`)
- Identity keys / prekeys / one-time prekeys (`server/src/routes/keys.ts`)
- Device ECDH keys and vault blobs (`users`, `devices`)
- Message delivery ciphertext slots (`message_deliveries`)
- TOTP secrets and replay state (`totp`, Redis single-use keys)
- Recovery key hash+salt (`server/src/lib/recovery-key.ts`)

## Data Flows And Invariants

### Auth + Session
- Challenge-response authentication must require possession of ECDSA private key.
- Refresh must rotate session identity (`jti`) and invalidate old token.
- Revoked devices/sessions must be denied on REST and WS paths.

### X3DH/Keys Directory
- Identity generation must be monotonic (no stale overwrite).
- Bundle fetch must be non-cacheable and OPK pop should be atomic.
- Self-bundle retrieval is forbidden.

### Messaging (Fanout + DR paths)
- Direct messages must contain per-device ciphertext slots.
- Server stores ciphertext only, not plaintext.
- Realtime delivery events must preserve membership and block checks.

### Vault
- Private keys remain encrypted at rest in client storage.
- Wrong PIN/tampered ciphertext must fail unwrap reliably.
- Legacy vault versions must remain readable; upgrade path must be deterministic.

## STRIDE Matrix (Prioritized)

## Critical
- **Spoofing:** WS ticket/session misuse allowing unauthorized socket events.
  - Controls: strict JWT scope checks, per-heartbeat revocation checks in `ws.ts`.
  - Tests: revoked `jti` and revoked `device_id` must close socket with policy violation.
- **Tampering:** key directory stale writes replacing identity/prekeys.
  - Controls: monotonic `generation`, identity prerequisite for SPK.
  - Tests: stale generation returns `IDENTITY_STALE_GENERATION`.

## High
- **Replay:** TOTP replay acceptance under race/retry conditions.
  - Controls: Redis `SET NX EX` + fallback memory guard.
  - Tests: second consume in TTL window must fail deterministically.
- **Repudiation:** session denylist persistence/fallback behavior.
  - Controls: Redis-backed denylist with TTL, in-memory fallback pruning.
  - Tests: expired denylist records are not treated as valid revocations.
- **Information Disclosure:** accidental cacheability of key bundles.
  - Controls: `Cache-Control: no-store` on `/api/keys/bundle/:userId`.
  - Tests: response header must always be `no-store`.

## Medium
- **DoS:** message/frame abuse (oversized WS payload, rate exhaustion).
  - Controls: WS size limit (64KB) + per-connection rate limit.
  - Tests: oversize and flood should be rejected with expected errors.
- **Elevation of Privilege:** cross-chat signaling or message sending.
  - Controls: membership checks on message and call flows.
  - Tests: non-member actions should return `NOT_A_MEMBER` / `NO_SHARED_CHAT`.

## Low
- **Config hardening drift:** weak secret loading fallback or unreadable secret files.
  - Controls: `readSecret/requireSecret`.
  - Tests: `_FILE` precedence and missing-secret failure semantics.

## Acceptance Criteria

- Every security-critical module has at least one negative-path automated test.
- Auth/session revocation is verifiable for both REST and WS paths.
- Key management endpoints are validated for monotonicity, cache control, and quota limits.
- Vault and crypto regression tests detect tamper/wrong-key regressions.
