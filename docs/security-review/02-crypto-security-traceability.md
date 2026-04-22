# Crypto/Security Traceability Matrix

## Server Modules

| Module | Risk Focus | Required Tests | Invariant |
|---|---|---|---|
| `server/src/lib/jwt-denylist.ts` | revoked token reuse | unit + TTL edge tests | denied JTI stays denied until expiry, then prunes |
| `server/src/lib/totp-replay-guard.ts` | OTP replay | unit + race/retry tests | same code for same user is single-use in active window |
| `server/src/lib/recovery-key.ts` | weak or bypassed recovery verification | unit tests | only exact key validates; mismatched lengths fail safely |
| `server/src/lib/read-secret.ts` | misconfigured secret source | unit tests | `_FILE` takes precedence when readable/non-empty |
| `server/src/routes/keys.ts` | identity/key directory tampering | route integration tests | stale generation rejected; bundle no-store; self-forbidden |
| `server/src/routes/ws.ts` | unauthorized realtime actions | ws integration tests | revoked session/device is disconnected on heartbeat |

## Client Modules

| Module | Risk Focus | Required Tests | Invariant |
|---|---|---|---|
| `client/src/lib/vault.ts` | vault decrypt regressions | unit tests (wrap/unwrap/upgrade) | wrong PIN or tamper never produces plaintext |
| `client/src/lib/vault-signing.ts` | invalid payload parsing/signing misuse | unit tests | only valid V2 payload can sign |
| `client/src/hooks/use-401-handler.ts` | auth redirect loops/session stale state | hook tests | first external 401 triggers logout+redirect once |
| `client/src/lib/ratchet/*` | protocol state corruption/replay | ratchet unit/integration | out-of-order/replay are handled without plaintext corruption |

## Coverage Gates

- **Critical path must-have**: denylist, TOTP replay, key directory, vault unwrap negative paths.
- **Security regression gate**: these tests run in CI on every PR.
- **Deep gate**: soak/load/chaos and expanded protocol permutation tests.
