# Security Test Suite Design

## Objectives

- Validate access control, session integrity, and abuse protections.
- Ensure revocation and step-up controls hold under edge conditions.

## Required Areas

1. **Auth/session**
   - challenge/verify/refresh/logout
   - denylist revocation timing and fallback paths
   - cookie and issuer/device claim handling

2. **Step-up and replay prevention**
   - TOTP single-use guarantees
   - step-up protected routes reject missing/invalid codes

3. **Key directory API**
   - stale generation rejection
   - no-store bundle responses
   - OPK pop semantics

4. **Secrets/config**
   - `_FILE` precedence and unreadable-file fallback
   - missing required secret throws early

5. **Realtime security**
   - WS heartbeat revocation handling
   - non-member action rejection

## Priority Cases Added

- `server/src/lib/jwt-denylist.test.ts`
- `server/src/lib/totp-replay-guard.test.ts`
- `server/src/lib/recovery-key.test.ts`
- `server/src/lib/read-secret.test.ts`
- `server/src/routes/keys.test.ts`
- `client/src/hooks/use-401-handler.test.ts` (auth loop guard logic)

## Exit Criteria

- Critical auth/session/key-management tests pass consistently.
- All newly added security unit/integration tests are wired into regular workspace test runs.
