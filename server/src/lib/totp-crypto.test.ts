import { afterEach, describe, expect, it, vi } from 'vitest'

const originalNodeEnv = process.env.NODE_ENV
const originalWrapKey = process.env.TOTP_WRAP_KEY

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
  process.env.TOTP_WRAP_KEY = originalWrapKey
  vi.resetModules()
})

describe('totp-crypto', () => {
  it('throws on encrypt in production when wrap key is missing', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.TOTP_WRAP_KEY

    const { encryptTotpSecret } = await import('./totp-crypto.js')
    expect(() => encryptTotpSecret('plain-secret')).toThrow(
      /TOTP_WRAP_KEY is required in production/
    )
  })

  it('roundtrips encrypted secret when wrap key is configured', async () => {
    process.env.NODE_ENV = 'production'
    process.env.TOTP_WRAP_KEY = '11'.repeat(32)

    const { encryptTotpSecret, decryptTotpSecret } = await import('./totp-crypto.js')
    const encrypted = encryptTotpSecret('plain-secret')

    expect(encrypted.startsWith('enc:v1:')).toBe(true)
    expect(decryptTotpSecret(encrypted)).toBe('plain-secret')
  })
})
