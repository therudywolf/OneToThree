import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  safeEqualNonce,
  safeEqualUtf8,
  verifyNonceSignatureEcdsaP256,
} from './ecdsa-verify.js'

describe('ecdsa-verify', () => {
  it('safeEqualNonce rejects length mismatch', () => {
    expect(safeEqualNonce('a', 'ab')).toBe(false)
  })

  it('safeEqualNonce accepts equal strings', () => {
    expect(safeEqualNonce('challenge', 'challenge')).toBe(true)
  })

  it('safeEqualUtf8 rejects different lengths and accepts equal content', () => {
    expect(safeEqualUtf8('wolf', 'wolves')).toBe(false)
    expect(safeEqualUtf8('wolf', 'wolf')).toBe(true)
  })

  it('verifyNonceSignatureEcdsaP256 accepts a valid ECDSA P-256 signature (DER)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    const jwk = publicKey.export({ format: 'jwk' })
    const pubStr = JSON.stringify(jwk)
    const nonce = 'test-nonce-utf8'
    const sign = createSign('SHA256')
    sign.update(nonce, 'utf8')
    sign.end()
    const sigDer = sign.sign(privateKey)
    const sigB64 = sigDer.toString('base64')
    expect(verifyNonceSignatureEcdsaP256(nonce, sigB64, pubStr)).toBe(true)
  })

  it('verifyNonceSignatureEcdsaP256 rejects garbage signature', () => {
    const { publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    const pubStr = JSON.stringify(publicKey.export({ format: 'jwk' }))
    expect(
      verifyNonceSignatureEcdsaP256('nonce', 'not-a-real-sig', pubStr)
    ).toBe(false)
  })

  it('verifyNonceSignatureEcdsaP256 accepts hex and base64url signature encodings', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    const pubStr = JSON.stringify(publicKey.export({ format: 'jwk' }))
    const nonce = 'test-nonce-encodings'
    const sign = createSign('SHA256')
    sign.update(nonce, 'utf8')
    sign.end()
    const sigDer = sign.sign(privateKey)

    const sigHex = sigDer.toString('hex')
    const sigB64Url = sigDer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')

    expect(verifyNonceSignatureEcdsaP256(nonce, sigHex, pubStr)).toBe(true)
    expect(verifyNonceSignatureEcdsaP256(nonce, sigB64Url, pubStr)).toBe(true)
  })
})
