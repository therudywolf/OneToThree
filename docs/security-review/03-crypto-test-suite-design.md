# Cryptography Test Suite Design

## Objectives

- Verify correctness and failure behavior of crypto operations.
- Prevent regressions in fanout, vault, and DR/X3DH flows.
- Keep critical negative-path tests in default CI gate.

## Required Test Packs

1. **Primitives and key ops**
   - ECDH shared secret interoperability
   - ECDSA sign/verify happy path and invalid signature path
   - AES-GCM roundtrip and tamper detection

2. **Vault**
   - wrap/unwrap roundtrip (current version)
   - wrong PIN must fail
   - legacy upgrade behavior

3. **Ratchet/X3DH**
   - initial session bootstrap and accept
   - prekey depletion behavior
   - replay/out-of-order handling
   - session re-establishment after state loss

4. **Transport-level invariants**
   - direct fanout requires ciphertext slots
   - malformed key material is rejected at boundaries

## Priority Cases Added

- `client/src/lib/vault.test.ts`
- `client/src/lib/vault-signing.test.ts`
- Existing `client/src/lib/crypto.test.ts` and `client/src/lib/ratchet/ratchet.test.ts` remain primary baseline.

## Coverage Target

- 100% of explicitly listed critical crypto modules have at least one negative-path test.
- For DR/X3DH, each lifecycle stage has at least one regression test.
