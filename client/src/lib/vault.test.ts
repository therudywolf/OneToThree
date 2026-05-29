import { describe, expect, it } from 'vitest'
import {
  CURRENT_VAULT_VERSION,
  unwrapPrivateJwkWithPin,
  upgradeVaultBlob,
  wrapPrivateJwkWithPin,
} from '@/lib/vault'

// Argon2id (t=3, m=64 MiB) is deliberately expensive. The upgrade-path test
// runs ~4 derivations (wrap + upgrade's unwrap/rewrap + final unwrap), and the
// deploy gate runs these on a CPU-contended VPS mid-Docker-build, where 15s was
// not enough and aborted deploys. Generous ceiling (not a fixed wait).
const VAULT_KDF_TEST_TIMEOUT_MS = 60_000

describe('vault wrap/unwrap', () => {
  it('roundtrips payload with current vault version', async () => {
    const payload = JSON.stringify({ v: 2, ecdsaPrivateJwk: '{"kty":"EC"}', ecdhPrivateJwk: '{"kty":"EC"}' })
    const blob = await wrapPrivateJwkWithPin(payload, '1234')
    expect(blob.version).toBe(CURRENT_VAULT_VERSION)
    await expect(unwrapPrivateJwkWithPin(blob, '1234')).resolves.toBe(payload)
  }, VAULT_KDF_TEST_TIMEOUT_MS)

  it('fails unwrap with wrong pin', async () => {
    const blob = await wrapPrivateJwkWithPin('secret', '0000')
    await expect(unwrapPrivateJwkWithPin(blob, '9999')).rejects.toThrow()
  }, VAULT_KDF_TEST_TIMEOUT_MS)

  it('keeps current-version blob unchanged in upgrade path', async () => {
    const current = await wrapPrivateJwkWithPin('{"k":"v"}', '1111')
    const upgraded = await upgradeVaultBlob(current, '1111')
    expect(upgraded.version).toBe(CURRENT_VAULT_VERSION)
    await expect(unwrapPrivateJwkWithPin(upgraded, '1111')).resolves.toBe('{"k":"v"}')
  }, VAULT_KDF_TEST_TIMEOUT_MS)
})
