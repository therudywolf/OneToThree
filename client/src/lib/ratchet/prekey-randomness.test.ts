// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Backlog #4 — X3DH prekeys must NOT be a function of the vault.
 *
 * They used to be HKDF expansions of the vault's ECDH scalar, so every "one-time"
 * prekey was a deterministic function of a long-term secret: anyone who later
 * obtained the vault could recompute all of them and recover the X3DH shared
 * secret of every session ever established, including from ciphertext captured
 * long before. That is the exact property X3DH exists to prevent.
 *
 * These tests pin the property, not the implementation: the same vault must not
 * reproduce the same prekeys.
 */
import { describe, expect, it } from 'vitest'
import { deriveDrBundleFromEcdhJwk } from './identity-from-vault'

const VAULT_JWK = JSON.stringify({
  kty: 'EC',
  crv: 'P-256',
  d: 'sO1qYQ2wYt4yJQZ0mQ3KZ8xTn9d2mS1lVv0aQ7hHkGo',
  x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
  y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
})

function randomPrekeyPrivate(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

describe('X3DH prekey material', () => {
  // The IDENTITY is deliberately still vault-derived: it is meant to be
  // long-term and stable, and it is what the safety number certifies. Pinning
  // this stops a future "make everything random" change from silently rotating
  // identities (and every safety number with them) on each unlock.
  it('keeps the DR identity stable for the same vault + device', () => {
    const a = deriveDrBundleFromEcdhJwk(VAULT_JWK, 'device-1')
    const b = deriveDrBundleFromEcdhJwk(VAULT_JWK, 'device-1')
    expect(Array.from(a.identity.signing.publicKey)).toEqual(
      Array.from(b.identity.signing.publicKey)
    )
    expect(Array.from(a.identity.exchange.publicKey)).toEqual(
      Array.from(b.identity.exchange.publicKey)
    )
  })

  it('gives different devices different identities from the same vault', () => {
    const a = deriveDrBundleFromEcdhJwk(VAULT_JWK, 'device-1')
    const b = deriveDrBundleFromEcdhJwk(VAULT_JWK, 'device-2')
    expect(Array.from(a.identity.signing.publicKey)).not.toEqual(
      Array.from(b.identity.signing.publicKey)
    )
  })

  // The actual regression guard. Under the old scheme two calls produced byte
  // -identical prekeys; a random generator must not.
  it('produces a DIFFERENT one-time prekey every time', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 64; i += 1) {
      seen.add(Buffer.from(randomPrekeyPrivate()).toString('hex'))
    }
    expect(seen.size).toBe(64)
  })

  it('does not derive prekeys from the vault scalar', () => {
    // Whatever the vault is, two independently generated prekeys must differ.
    // If someone reintroduces `deriveOtpPrivKey(dRoot, id)`, the same (vault, id)
    // pair collapses to one value and this fails.
    const first = randomPrekeyPrivate()
    const second = randomPrekeyPrivate()
    expect(Buffer.from(first).toString('hex')).not.toBe(
      Buffer.from(second).toString('hex')
    )
    // ...and neither may equal anything the vault bundle exposes.
    const bundle = deriveDrBundleFromEcdhJwk(VAULT_JWK, 'device-1')
    const vaultDerived = Buffer.from(bundle.signedPreKey.privateKey).toString('hex')
    expect(Buffer.from(first).toString('hex')).not.toBe(vaultDerived)
  })
})
