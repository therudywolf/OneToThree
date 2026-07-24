import { describe, expect, it } from 'vitest'
import {
  generateKeyPair,
  generateKeyPairIsolated,
  exportPublicKey,
  importEcdhPublicKey,
  importEcdhPrivateKey,
  deriveSharedSecret,
  KDF_CTX,
  encryptMessage,
  decryptMessage,
  hashPublicKeyJwk,
  generateSafetyNumber,
  generateEcdsaP256KeyPairIsolated,
  importEcdsaPrivateKeyForSign,
  signUtf8WithEcdsaP256,
} from '@/lib/crypto'

/** Fixed P-256 public JWKs — used for deterministic safety number tests. */
const STATIC_P256_JWK_A: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
  y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
}

const STATIC_P256_JWK_B: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
}

describe('generateSafetyNumber', () => {
  it('returns 6 blocks of 5 digits (30 digits total) deterministically', async () => {
    const a = await generateSafetyNumber(STATIC_P256_JWK_A, STATIC_P256_JWK_B)
    const b = await generateSafetyNumber(STATIC_P256_JWK_A, STATIC_P256_JWK_B)
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}$/)
    expect(a.replace(/\s/g, '').length).toBe(30)
  })

  it('produces the same safety number regardless of key order', async () => {
    const ab = await generateSafetyNumber(STATIC_P256_JWK_A, STATIC_P256_JWK_B)
    const ba = await generateSafetyNumber(STATIC_P256_JWK_B, STATIC_P256_JWK_A)
    expect(ab).toBe(ba)
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

describe('generateKeyPair (ECDH) – legacy compat', () => {
  it('returns a CryptoKeyPair with publicKey and privateKey', async () => {
    const pair = await generateKeyPair()
    expect(pair).toHaveProperty('publicKey')
    expect(pair).toHaveProperty('privateKey')
    expect(pair.publicKey).toBeInstanceOf(CryptoKey)
    expect(pair.privateKey).toBeInstanceOf(CryptoKey)
  })

  it('generates extractable keys by default (legacy behaviour preserved)', async () => {
    const pair = await generateKeyPair()
    expect(pair.publicKey.extractable).toBe(true)
    // privateKey is still extractable:true here because generateKeyPair() is
    // the legacy path used by the vault bootstrap flow.
    // New code must use generateKeyPairIsolated() instead.
    expect(pair.privateKey.extractable).toBe(true)
  })

  it('generates P-256 curve keys by default', async () => {
    const pair = await generateKeyPair()
    expect((pair.publicKey.algorithm as EcKeyAlgorithm).namedCurve).toBe('P-256')
  })
})

describe('generateKeyPairIsolated (ECDH) – Stage 1', () => {
  it('returns privateKey with extractable:false', async () => {
    const isolated = await generateKeyPairIsolated()
    expect(isolated.privateKey.extractable).toBe(false)
  })

  it('returns publicKey with extractable:true', async () => {
    const isolated = await generateKeyPairIsolated()
    expect(isolated.publicKey.extractable).toBe(true)
  })

  it('privateJwk is a valid JWK string containing private component d', async () => {
    const isolated = await generateKeyPairIsolated()
    const jwk = JSON.parse(isolated.privateJwk) as JsonWebKey
    expect(jwk.kty).toBe('EC')
    expect(jwk.crv).toBe('P-256')
    expect(typeof jwk.d).toBe('string')
  })

  it('publicJwk does not contain private component d', async () => {
    const isolated = await generateKeyPairIsolated()
    const jwk = JSON.parse(isolated.publicJwk) as JsonWebKey
    expect(jwk).not.toHaveProperty('d')
    expect(jwk.x).toBeTruthy()
    expect(jwk.y).toBeTruthy()
  })

  it('re-imported private key (non-extractable) can derive shared secret and encrypt/decrypt', async () => {
    const alice = await generateKeyPairIsolated()
    const bob   = await generateKeyPairIsolated()

    const bobPub = await importEcdhPublicKey(bob.publicJwk)
    const alicePub = await importEcdhPublicKey(alice.publicJwk)

    const aliceShared = await deriveSharedSecret(alice.privateKey, bobPub)
    const bobShared   = await deriveSharedSecret(bob.privateKey, alicePub)

    const plaintext = 'isolated key roundtrip'
    const { ciphertext, iv } = await encryptMessage(aliceShared, plaintext)
    const decrypted = await decryptMessage(bobShared, ciphertext, iv)
    expect(decrypted).toBe(plaintext)
  })

  it('private key loaded from JWK via importEcdhPrivateKey is non-extractable', async () => {
    const isolated = await generateKeyPairIsolated()
    const reloaded = await importEcdhPrivateKey(isolated.privateJwk)
    expect(reloaded.extractable).toBe(false)
  })
})

describe('deriveSharedSecret – Stage 1', () => {
  it('shared AES key is non-extractable (cannot leave JS heap)', async () => {
    const alice = await generateKeyPairIsolated()
    const bob   = await generateKeyPairIsolated()
    const bobPub = await importEcdhPublicKey(bob.publicJwk)
    const shared = await deriveSharedSecret(alice.privateKey, bobPub)
    expect(shared.extractable).toBe(false)
  })

  it('two participants derive the same shared AES key', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()

    const alicePubJwk = await exportPublicKey(alice.publicKey)
    const bobPubJwk = await exportPublicKey(bob.publicKey)

    const bobPub = await importEcdhPublicKey(bobPubJwk)
    const alicePub = await importEcdhPublicKey(alicePubJwk)

    const aliceShared = await deriveSharedSecret(alice.privateKey, bobPub)
    const bobShared = await deriveSharedSecret(bob.privateKey, alicePub)

    const plaintext = 'shared secret test'
    const { ciphertext, iv } = await encryptMessage(aliceShared, plaintext)
    const decrypted = await decryptMessage(bobShared, ciphertext, iv)
    expect(decrypted).toBe(plaintext)
  })

  // #34 — KDF domain separation. The SAME ECDH pair must derive a DISTINCT AES
  // key per context, so a key minted for a call relay can never coincide with
  // one minted for a group-key wrap (which would make a nonce collision across
  // the two contexts a cross-context two-time pad).
  it('the same ECDH pair derives distinct keys per KDF context', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const bobPub = await importEcdhPublicKey(await exportPublicKey(bob.publicKey))

    const kLegacy = await deriveSharedSecret(alice.privateKey, bobPub, KDF_CTX.LEGACY)
    const kCall = await deriveSharedSecret(alice.privateKey, bobPub, KDF_CTX.CALL)
    const kWrap = await deriveSharedSecret(alice.privateKey, bobPub, KDF_CTX.GROUP_WRAP)

    // A ciphertext sealed under one context must NOT open under another.
    const { ciphertext, iv } = await encryptMessage(kCall, 'call-frame')
    await expect(decryptMessage(kLegacy, ciphertext, iv)).rejects.toThrow()
    await expect(decryptMessage(kWrap, ciphertext, iv)).rejects.toThrow()
    // …but opens under its own context (same pair, same label → same key).
    expect(await decryptMessage(kCall, ciphertext, iv)).toBe('call-frame')

    // Default (no context arg) is byte-identical to the explicit v1 label, so
    // pre-#34 callers keep their exact derivation.
    const kDefault = await deriveSharedSecret(alice.privateKey, bobPub)
    const probe = await encryptMessage(kDefault, 'legacy')
    expect(await decryptMessage(kLegacy, probe.ciphertext, probe.iv)).toBe('legacy')
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
    expect(jwk).not.toHaveProperty('d')
  })
})

describe('hashPublicKeyJwk', () => {
  it('returns the same hash for the same input (deterministic)', async () => {
    const hashA = await hashPublicKeyJwk(STATIC_P256_JWK_A)
    const hashB = await hashPublicKeyJwk(STATIC_P256_JWK_A)
    expect(hashA).toBe(hashB)
  })

  it('returns a 64-character hex string (SHA-256)', async () => {
    const hash = await hashPublicKeyJwk(STATIC_P256_JWK_A)
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

describe('generateEcdsaP256KeyPairIsolated – Stage 1', () => {
  it('returns non-extractable ECDSA private key', async () => {
    const isolated = await generateEcdsaP256KeyPairIsolated()
    expect(isolated.privateKey.extractable).toBe(false)
  })

  it('private key can sign after isolation', async () => {
    const isolated = await generateEcdsaP256KeyPairIsolated()
    const sig = await signUtf8WithEcdsaP256(isolated.privateKey, 'test payload')
    expect(typeof sig).toBe('string')
    expect(sig.length).toBeGreaterThan(0)
  })

  it('private key loaded from JWK via importEcdsaPrivateKeyForSign is non-extractable', async () => {
    const isolated = await generateEcdsaP256KeyPairIsolated()
    const reloaded = await importEcdsaPrivateKeyForSign(isolated.privateJwk)
    expect(reloaded.extractable).toBe(false)
  })
})
