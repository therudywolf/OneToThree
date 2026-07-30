import { describe, it, expect } from 'vitest'
import {
  generateRecoveryMnemonic,
  validateRecoveryMnemonic,
  deriveRecoveryAuthKeypair,
} from './recovery-secret'
import { wrapPrivateJwkWithPin, unwrapPrivateJwkWithPin } from '@/lib/vault'

const importPriv = (jwk: string) =>
  crypto.subtle.importKey('jwk', JSON.parse(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
const importPub = (jwk: string) =>
  crypto.subtle.importKey('jwk', JSON.parse(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])

describe('recovery phrase', () => {
  it('generates a valid 24-word phrase', () => {
    const m = generateRecoveryMnemonic()
    expect(m.split(' ').length).toBe(24)
    expect(validateRecoveryMnemonic(m)).toBe(true)
  })

  /**
   * Fixed vectors, not a freshly generated phrase with one word swapped: a
   * 24-word mnemonic carries an 8-bit checksum, so a random single-word tamper
   * still validates about 1 run in 256. That is exactly often enough to fail a
   * CI job for no reason and teach everyone to re-run it.
   *
   * The pair below is all-zero entropy (the canonical BIP39 vector) and the
   * same phrase with its checksum word replaced. The positive case is asserted
   * too, so a wrong vector shows up as a wrong vector rather than as a passing
   * test that proves nothing.
   */
  const VALID_VECTOR = `${'abandon '.repeat(23)}art`
  const TAMPERED_VECTOR = `${'abandon '.repeat(23)}zoo`

  it('rejects garbage / a tampered word (BIP39 checksum)', () => {
    expect(validateRecoveryMnemonic('not a real recovery phrase at all')).toBe(false)
    expect(validateRecoveryMnemonic(VALID_VECTOR)).toBe(true)
    expect(validateRecoveryMnemonic(TAMPERED_VECTOR)).toBe(false)
  })

  it('derives the auth keypair deterministically (case/space-insensitive)', () => {
    const m = generateRecoveryMnemonic()
    const a = deriveRecoveryAuthKeypair(m)
    const b = deriveRecoveryAuthKeypair(m)
    expect(a.publicJwk).toBe(b.publicJwk)
    expect(a.privateJwk).toBe(b.privateJwk)
    const c = deriveRecoveryAuthKeypair(`   ${m.toUpperCase()}   `)
    expect(c.publicJwk).toBe(a.publicJwk)
  })

  it('different phrases -> different keypairs', () => {
    const a = deriveRecoveryAuthKeypair(generateRecoveryMnemonic())
    const b = deriveRecoveryAuthKeypair(generateRecoveryMnemonic())
    expect(a.publicJwk).not.toBe(b.publicJwk)
  })

  it('the derived keypair signs a nonce that the public JWK verifies (ECDSA P-256 / SHA-256)', async () => {
    const { privateJwk, publicJwk } = deriveRecoveryAuthKeypair(generateRecoveryMnemonic())
    const priv = await importPriv(privateJwk)
    const pub = await importPub(publicJwk)
    const nonce = new TextEncoder().encode('00000000-0000-4000-8000-000000000000')
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, nonce)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, nonce)).toBe(true)
    // A different nonce must NOT verify against the same signature.
    const other = new TextEncoder().encode('11111111-1111-4111-8111-111111111111')
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, other)).toBe(false)
  })

  it('the recovery blob round-trips the keyring under the phrase (reuses vault.ts)', async () => {
    const inner = JSON.stringify({ v: 2, ecdsaPrivateJwk: '{"d":"aaa"}', ecdhPrivateJwk: '{"d":"bbb"}' })
    const m = generateRecoveryMnemonic()
    const blob = await wrapPrivateJwkWithPin(inner, m)
    expect(await unwrapPrivateJwkWithPin(blob, m)).toBe(inner)
    await expect(unwrapPrivateJwkWithPin(blob, generateRecoveryMnemonic())).rejects.toThrow()
  }, 30_000) // Argon2id is intentionally memory-hard/slow; 3 ops exceed the 5s default.
})
