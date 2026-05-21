import { describe, expect, it } from 'vitest'
import {
  generateLinkEphemeralKeypair,
  encryptVaultToEphemeralKey,
  decryptVaultFromEphemeralKey,
  buildLinkQrPayload,
  parseLinkQrPayload,
  buildLinkModeBQrPayload,
  parseLinkModeBQrPayload,
  deriveLinkVerificationCode,
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

describe('device-link Mode B QR', () => {
  it('round-trips the Mode B QR payload', () => {
    const encoded = buildLinkModeBQrPayload('rdv-abc', 'claim-secret-xyz')
    const parsed = parseLinkModeBQrPayload(encoded)
    expect(parsed).toEqual({ rendezvousId: 'rdv-abc', claimSecret: 'claim-secret-xyz' })
  })

  it('rejects foreign and Mode A QR strings as Mode B', () => {
    expect(parseLinkModeBQrPayload('not-json')).toBeNull()
    expect(parseLinkModeBQrPayload('https://example.com')).toBeNull()
    // A Mode A QR must not parse as Mode B (distinct tags).
    const modeA = buildLinkQrPayload('rdv-1', '{"kty":"EC"}')
    expect(parseLinkModeBQrPayload(modeA)).toBeNull()
  })

  it('does not parse a Mode B QR as Mode A (tags are distinct)', () => {
    const modeB = buildLinkModeBQrPayload('rdv-1', 'secret')
    expect(parseLinkQrPayload(modeB)).toBeNull()
  })
})

describe('device-link verification code', () => {
  it('produces a deterministic 6-digit code', async () => {
    const a = await deriveLinkVerificationCode('rdv-1', 'pubkey-jwk-string')
    const b = await deriveLinkVerificationCode('rdv-1', 'pubkey-jwk-string')
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{6}$/)
  })

  it('differs when the ephemeral pubkey differs (same rendezvous)', async () => {
    // Models an attacker racing a different key into submit-pubkey: the two
    // devices then derive different codes and the user aborts.
    const genuine = await deriveLinkVerificationCode('rdv-1', 'genuine-key')
    const attacker = await deriveLinkVerificationCode('rdv-1', 'attacker-key')
    expect(genuine).not.toBe(attacker)
  })

  it('differs when the rendezvous id differs (same pubkey)', async () => {
    const a = await deriveLinkVerificationCode('rdv-1', 'same-key')
    const b = await deriveLinkVerificationCode('rdv-2', 'same-key')
    expect(a).not.toBe(b)
  })

  it('matches between the two sides for a real ephemeral keypair', async () => {
    // The existing device receives the exact JWK string the new device
    // uploaded, so both derive the identical code.
    const kp = await generateLinkEphemeralKeypair()
    const newDeviceCode = await deriveLinkVerificationCode('rdv-real', kp.publicJwk)
    const existingDeviceCode = await deriveLinkVerificationCode('rdv-real', kp.publicJwk)
    expect(newDeviceCode).toBe(existingDeviceCode)
    expect(newDeviceCode).toMatch(/^\d{6}$/)
  })
})
