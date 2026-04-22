import { describe, expect, it } from 'vitest'
import {
  CURRENT_VAULT_VERSION,
  unwrapPrivateJwkWithPin,
  upgradeVaultBlob,
  wrapPrivateJwkWithPin,
} from '@/lib/vault'

describe('vault wrap/unwrap', () => {
  it('roundtrips payload with current vault version', async () => {
    const payload = JSON.stringify({ v: 2, ecdsaPrivateJwk: '{"kty":"EC"}', ecdhPrivateJwk: '{"kty":"EC"}' })
    const blob = await wrapPrivateJwkWithPin(payload, '1234')
    expect(blob.version).toBe(CURRENT_VAULT_VERSION)
    await expect(unwrapPrivateJwkWithPin(blob, '1234')).resolves.toBe(payload)
  })

  it('fails unwrap with wrong pin', async () => {
    const blob = await wrapPrivateJwkWithPin('secret', '0000')
    await expect(unwrapPrivateJwkWithPin(blob, '9999')).rejects.toThrow()
  })

  it('keeps current-version blob unchanged in upgrade path', async () => {
    const current = await wrapPrivateJwkWithPin('{"k":"v"}', '1111')
    const upgraded = await upgradeVaultBlob(current, '1111')
    expect(upgraded.version).toBe(CURRENT_VAULT_VERSION)
    await expect(unwrapPrivateJwkWithPin(upgraded, '1111')).resolves.toBe('{"k":"v"}')
  })
})
