import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  safeEqualNonce,
  verifyNonceSignatureEcdsaP256,
} from './ecdsa-verify.js'

describe('ecdsa-verify', () => {
  it('safeEqualNonce rejects length mismatch', () => {
    expect(safeEqualNonce('a', 'ab')).toBe(false)
  })

  it('safeEqualNonce accepts equal strings', () => {
    expect(safeEqualNonce('challenge', 'challenge')).toBe(true)
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
})
