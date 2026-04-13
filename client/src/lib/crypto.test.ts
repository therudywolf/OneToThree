import { describe, expect, it } from 'vitest'
import {
  generateKeyPair,
  exportPublicKey,
  importEcdhPublicKey,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  hashPublicKeyJwk,
  generateSafetyNumber,
} from '@/lib/crypto'

/** Fixed P-256 public JWK — golden fingerprint computed via Web Crypto SHA-256 + decimal projection. */
const STATIC_P256_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
  y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
}

describe('generateSafetyNumber', () => {
  it('returns 6 blocks of 5 digits (30 digits total) deterministically', async () => {
    const a = await generateSafetyNumber(STATIC_P256_JWK)
    const b = await generateSafetyNumber(STATIC_P256_JWK)
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}$/)
    expect(a.replace(/\s/g, '').length).toBe(30)
  })

  it('matches golden fingerprint for canonical sorted JWK JSON', async () => {
    const n = await generateSafetyNumber(STATIC_P256_JWK)
    expect(n).toBe('51788 99978 45460 91471 42841 45456')
  })
})

describe('encryptMessage / decryptMessage roundtrip', () => {
  it('encrypts and decrypts a plaintext string with AES-GCM', async () => {
    const keyPairA = await generateKeyPair()
    const keyPairB = await generateKeyPair()

    const pubAJwk = await exportPublicKey(keyPairA.publicKey)
    const pubBImported = await importEcdhPublicKey(pubAJwk)
    const sharedKey = await deriveSharedSecret(keyPairB.privateKey, pubBImported)

    const plaintext = 'Hello, End-to-End Encryption!'
    const { ciphertext, iv } = await encryptMessage(sharedKey, plaintext)

    expect(ciphertext).toBeTruthy()
    expect(iv).toBeTruthy()
    expect(ciphertext).not.toBe(plaintext)

    const decrypted = await decryptMessage(sharedKey, ciphertext, iv)
    expect(decrypted).toBe(plaintext)
  })

  it('handles empty string roundtrip', async () => {
    const pair = await generateKeyPair()
    const pubJwk = await exportPublicKey(pair.publicKey)
    const pubKey = await importEcdhPublicKey(pubJwk)
    const sharedKey = await deriveSharedSecret(pair.privateKey, pubKey)

    const { ciphertext, iv } = await encryptMessage(sharedKey, '')
    const decrypted = await decryptMessage(sharedKey, ciphertext, iv)
    expect(decrypted).toBe('')
  })

  it('handles unicode text roundtrip', async () => {
    const pair = await generateKeyPair()
    const pubJwk = await exportPublicKey(pair.publicKey)
    const pubKey = await importEcdhPublicKey(pubJwk)
    const sharedKey = await deriveSharedSecret(pair.privateKey, pubKey)

    const plaintext = 'Привет мир! 🔐 日本語テスト'
    const { ciphertext, iv } = await encryptMessage(sharedKey, plaintext)
    const decrypted = await decryptMessage(sharedKey, ciphertext, iv)
    expect(decrypted).toBe(plaintext)
  })
})

describe('generateKeyPair (ECDH)', () => {
  it('returns a CryptoKeyPair with publicKey and privateKey', async () => {
    const pair = await generateKeyPair()
    expect(pair).toHaveProperty('publicKey')
    expect(pair).toHaveProperty('privateKey')
    expect(pair.publicKey).toBeInstanceOf(CryptoKey)
    expect(pair.privateKey).toBeInstanceOf(CryptoKey)
  })

  it('generates extractable keys by default', async () => {
    const pair = await generateKeyPair()
    expect(pair.publicKey.extractable).toBe(true)
    expect(pair.privateKey.extractable).toBe(true)
  })

  it('generates P-256 curve keys by default', async () => {
    const pair = await generateKeyPair()
    expect((pair.publicKey.algorithm as EcKeyAlgorithm).namedCurve).toBe('P-256')
  })
})

describe('exportPublicKey → JWK', () => {
  it('returns a valid JWK string with crv P-256', async () => {
    const pair = await generateKeyPair()
    const jwkString = await exportPublicKey(pair.publicKey)
    const jwk = JSON.parse(jwkString) as JsonWebKey

    expect(jwk.kty).toBe('EC')
    expect(jwk.crv).toBe('P-256')
    expect(jwk.x).toBeTruthy()
    expect(jwk.y).toBeTruthy()
    // Public key should NOT have private component
    expect(jwk).not.toHaveProperty('d')
  })
})

describe('hashPublicKeyJwk', () => {
  it('returns the same hash for the same input (deterministic)', async () => {
    const hashA = await hashPublicKeyJwk(STATIC_P256_JWK)
    const hashB = await hashPublicKeyJwk(STATIC_P256_JWK)
    expect(hashA).toBe(hashB)
  })

  it('returns a 64-character hex string (SHA-256)', async () => {
    const hash = await hashPublicKeyJwk(STATIC_P256_JWK)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces different hashes for different keys', async () => {
    const pairA = await generateKeyPair()
    const pairB = await generateKeyPair()
    const jwkA = JSON.parse(await exportPublicKey(pairA.publicKey)) as JsonWebKey
    const jwkB = JSON.parse(await exportPublicKey(pairB.publicKey)) as JsonWebKey

    const hashA = await hashPublicKeyJwk(jwkA)
    const hashB = await hashPublicKeyJwk(jwkB)
    expect(hashA).not.toBe(hashB)
  })
})

describe('deriveSharedSecret (ECDH)', () => {
  it('two participants derive the same shared AES key', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()

    const alicePubJwk = await exportPublicKey(alice.publicKey)
    const bobPubJwk = await exportPublicKey(bob.publicKey)

    const bobPub = await importEcdhPublicKey(bobPubJwk)
    const alicePub = await importEcdhPublicKey(alicePubJwk)

    // Alice derives shared secret with Bob's public key
    const aliceShared = await deriveSharedSecret(alice.privateKey, bobPub)
    // Bob derives shared secret with Alice's public key
    const bobShared = await deriveSharedSecret(bob.privateKey, alicePub)

    // Encrypt with Alice's key, decrypt with Bob's key
    const plaintext = 'shared secret test'
    const { ciphertext, iv } = await encryptMessage(aliceShared, plaintext)
    const decrypted = await decryptMessage(bobShared, ciphertext, iv)
    expect(decrypted).toBe(plaintext)
  })
})
