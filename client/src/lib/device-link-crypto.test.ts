import { describe, expect, it } from 'vitest'
import {
  generateLinkEphemeralKeypair,
  encryptVaultToEphemeralKey,
  decryptVaultFromEphemeralKey,
  buildLinkQrPayload,
  parseLinkQrPayload,
} from './device-link-crypto'

const SAMPLE_VAULT = JSON.stringify({
  saltB64: 'c2FsdC1zYWx0LXNhbHQtc2FsdA',
  ivB64: 'aXYtaXYtaXYtaXY',
  ciphertextB64: 'Y2lwaGVydGV4dC1ibG9iLWdvZXMtaGVyZQ',
})

describe('device-link ECIES', () => {
  it('round-trips a vault blob through the ephemeral key', async () => {
    const newDevice = await generateLinkEphemeralKeypair()
    const packaged = await encryptVaultToEphemeralKey(SAMPLE_VAULT, newDevice.publicJwk)
    expect(packaged).not.toContain(SAMPLE_VAULT)

    const decrypted = await decryptVaultFromEphemeralKey(packaged, newDevice.privateJwk)
    expect(decrypted).toBe(SAMPLE_VAULT)
  })

  it('produces a fresh envelope each time (per-handoff sender key)', async () => {
    const newDevice = await generateLinkEphemeralKeypair()
    const a = await encryptVaultToEphemeralKey(SAMPLE_VAULT, newDevice.publicJwk)
    const b = await encryptVaultToEphemeralKey(SAMPLE_VAULT, newDevice.publicJwk)
    expect(a).not.toBe(b)
  })

  it('fails to decrypt with a different ephemeral key', async () => {
    const intended = await generateLinkEphemeralKeypair()
    const attacker = await generateLinkEphemeralKeypair()
    const packaged = await encryptVaultToEphemeralKey(SAMPLE_VAULT, intended.publicJwk)

    await expect(
      decryptVaultFromEphemeralKey(packaged, attacker.privateJwk)
    ).rejects.toThrow()
  })

  it('rejects a tampered ciphertext', async () => {
    const newDevice = await generateLinkEphemeralKeypair()
    const packaged = await encryptVaultToEphemeralKey(SAMPLE_VAULT, newDevice.publicJwk)
    const env = JSON.parse(packaged) as { ct: string }
    const tampered = JSON.stringify({
      ...JSON.parse(packaged),
      ct: env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA'),
    })

    await expect(
      decryptVaultFromEphemeralKey(tampered, newDevice.privateJwk)
    ).rejects.toThrow()
  })

  it('rejects a malformed envelope', async () => {
    const newDevice = await generateLinkEphemeralKeypair()
    await expect(
      decryptVaultFromEphemeralKey('not-json', newDevice.privateJwk)
    ).rejects.toThrow('INVALID_LINK_PAYLOAD')
    await expect(
      decryptVaultFromEphemeralKey(JSON.stringify({ v: 1 }), newDevice.privateJwk)
    ).rejects.toThrow('INVALID_LINK_PAYLOAD')
  })

  it('round-trips the QR payload and rejects foreign QR strings', () => {
    const encoded = buildLinkQrPayload('rdv-123', '{"kty":"EC","crv":"P-256","x":"a","y":"b"}')
    const parsed = parseLinkQrPayload(encoded)
    expect(parsed).toEqual({
      rendezvousId: 'rdv-123',
      ephemeralPubkey: '{"kty":"EC","crv":"P-256","x":"a","y":"b"}',
    })
    expect(parseLinkQrPayload('https://example.com')).toBeNull()
    expect(parseLinkQrPayload('not-json')).toBeNull()
    expect(parseLinkQrPayload(JSON.stringify({ t: 'other', r: 'x', k: 'y' }))).toBeNull()
  })
})
