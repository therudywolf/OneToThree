import { describe, expect, it } from 'vitest'
import {
  PasskeyKeyringError,
  b64urlToBytes,
  bytesToB64url,
  sealKeyring,
  unsealKeyring,
} from '@/lib/passkey-keyring'

const secret = () => new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff))

describe('passkey-sealed keyring (crypto half, no WebAuthn)', () => {
  it('round-trips the keyring plaintext under the PRF secret', async () => {
    const plaintext = JSON.stringify({ v: 2, ecdsa: { kty: 'EC', d: 'x' }, ecdh: { kty: 'EC', d: 'y' } })
    const sealed = await sealKeyring(plaintext, secret())
    expect(sealed.hkdf_salt).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sealed.wrap_iv).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sealed.wrapped_keyring).toMatch(/^[A-Za-z0-9_-]+$/)
    // The server stores exactly these three fields; nothing in them is the
    // plaintext or the secret.
    expect(sealed.wrapped_keyring).not.toContain('ecdsa')
    expect(sealed.wrapped_keyring).not.toBe(bytesToB64url(secret()))
    await expect(unsealKeyring(sealed, secret())).resolves.toBe(plaintext)
  })

  it('a different PRF secret cannot unseal it', async () => {
    const sealed = await sealKeyring('keyring', secret())
    const wrong = secret()
    wrong[0] ^= 1
    await expect(unsealKeyring(sealed, wrong)).rejects.toBeInstanceOf(PasskeyKeyringError)
    await expect(unsealKeyring(sealed, wrong)).rejects.toMatchObject({ code: 'PASSKEY_UNSEAL_FAILED' })
  })

  it('a tampered ciphertext is rejected', async () => {
    const sealed = await sealKeyring('keyring', secret())
    const bytes = b64urlToBytes(sealed.wrapped_keyring)
    bytes[bytes.length - 1] ^= 0x01
    await expect(
      unsealKeyring({ ...sealed, wrapped_keyring: bytesToB64url(bytes) }, secret()),
    ).rejects.toMatchObject({ code: 'PASSKEY_UNSEAL_FAILED' })
  })

  it('two enrolments of the same plaintext never share salts or ciphertext', async () => {
    const a = await sealKeyring('keyring', secret())
    const b = await sealKeyring('keyring', secret())
    expect(a.hkdf_salt).not.toBe(b.hkdf_salt)
    expect(a.wrap_iv).not.toBe(b.wrap_iv)
    expect(a.wrapped_keyring).not.toBe(b.wrapped_keyring)
  })

  it('base64url helpers round-trip and drop padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const s = bytesToB64url(bytes)
    expect(s).not.toMatch(/[+/=]/)
    expect(Array.from(b64urlToBytes(s))).toEqual(Array.from(bytes))
  })
})
