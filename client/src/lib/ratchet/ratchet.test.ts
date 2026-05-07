import { describe, expect, it } from 'vitest'
import {
  computeSafetyNumber,
  decryptRatchet,
  encryptRatchet,
  generateIdentity,
  generateX25519KeyPair,
  initRatchetAsAlice,
  initRatchetAsBob,
  signWithIdentity,
  x3dhInitiator,
  x3dhResponder,
  verifyBundleSignature,
  type PreKeyBundle,
} from '.'

function te(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
function td(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

describe('X3DH handshake', () => {
  it('initiator and responder derive the same shared secret', () => {
    const alice = generateIdentity()
    const bob = generateIdentity()
    const bobSpk = generateX25519KeyPair()
    const bobOpk = generateX25519KeyPair()
    const signature = signWithIdentity(bob, bobSpk.publicKey)
    const bundle: PreKeyBundle = {
      userId: 'bob',
      identitySigning: bob.signing.publicKey,
      identityExchange: bob.exchange.publicKey,
      signedPreKey: { id: 1, publicKey: bobSpk.publicKey, signature },
      oneTimePreKey: { id: 2, publicKey: bobOpk.publicKey },
    }
    expect(verifyBundleSignature(bundle)).toBe(true)

    const aliceEphemeral = generateX25519KeyPair()
    const aliceResult = x3dhInitiator({
      initiatorIdentity: alice,
      ephemeral: aliceEphemeral,
      bundle,
    })

    const bobResult = x3dhResponder({
      responderIdentity: bob,
      signedPreKey: bobSpk,
      oneTimePreKey: bobOpk,
      initiatorIdentityPublic: alice.exchange.publicKey,
      initiatorEphemeralPublic: aliceEphemeral.publicKey,
    })

    expect(Array.from(aliceResult.sharedSecret)).toEqual(
      Array.from(bobResult.sharedSecret)
    )
  })

  it('detects signed pre-key signature forgery', () => {
    const alice = generateIdentity()
    const bob = generateIdentity()
    const impostor = generateIdentity()
    const spk = generateX25519KeyPair()
    const badSig = signWithIdentity(impostor, spk.publicKey)
    const bundle: PreKeyBundle = {
      userId: 'bob',
      identitySigning: bob.signing.publicKey,
      identityExchange: bob.exchange.publicKey,
      signedPreKey: { id: 1, publicKey: spk.publicKey, signature: badSig },
      oneTimePreKey: null,
    }
    expect(verifyBundleSignature(bundle)).toBe(false)
    const aliceEphemeral = generateX25519KeyPair()
    expect(() =>
      x3dhInitiator({
        initiatorIdentity: alice,
        ephemeral: aliceEphemeral,
        bundle,
      })
    ).toThrowError('X3DH_BAD_SPK_SIGNATURE')
  })
})

describe('Double Ratchet', () => {
  async function establish() {
    const sharedSecret = new Uint8Array(32)
    crypto.getRandomValues(sharedSecret)
    const bobInitialDh = generateX25519KeyPair()
    const alice = initRatchetAsAlice({
      sharedSecret,
      remoteDhPublic: bobInitialDh.publicKey,
    })
    const bob = initRatchetAsBob({
      sharedSecret,
      selfDh: bobInitialDh,
    })
    return { alice, bob }
  }

  it('encrypts and decrypts a single message', async () => {
    const { alice, bob } = await establish()
    const msg = await encryptRatchet(alice, te('hello bob'))
    const plain = await decryptRatchet(bob, msg)
    expect(td(plain)).toBe('hello bob')
  })

  it('survives many alternating messages', async () => {
    const { alice, bob } = await establish()
    // Alice -> Bob x3
    for (let i = 0; i < 3; i += 1) {
      const m = await encryptRatchet(alice, te(`a${i}`))
      expect(td(await decryptRatchet(bob, m))).toBe(`a${i}`)
    }
    // Bob -> Alice x2 (triggers DH ratchet on Alice)
    for (let i = 0; i < 2; i += 1) {
      const m = await encryptRatchet(bob, te(`b${i}`))
      expect(td(await decryptRatchet(alice, m))).toBe(`b${i}`)
    }
    // Alice -> Bob again
    const m = await encryptRatchet(alice, te('a-final'))
    expect(td(await decryptRatchet(bob, m))).toBe('a-final')
  })

  it('handles out-of-order delivery within skip budget', async () => {
    const { alice, bob } = await establish()
    const msgs = []
    for (let i = 0; i < 5; i += 1) {
      msgs.push(await encryptRatchet(alice, te(`m${i}`)))
    }
    // Deliver in reverse
    const reversed = msgs.slice().reverse()
    const decrypted: string[] = []
    for (const m of reversed) {
      decrypted.push(td(await decryptRatchet(bob, m)))
    }
    expect(decrypted.sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('rejects tampered ciphertext', async () => {
    const { alice, bob } = await establish()
    const msg = await encryptRatchet(alice, te('critical'))
    msg.ciphertext[0] ^= 0xff
    await expect(decryptRatchet(bob, msg)).rejects.toThrow()
  })
})

describe('Safety numbers', () => {
  it('produces a 60-digit grouped number that is order-independent', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const numberAB = computeSafetyNumber(a.exchange.publicKey, b.exchange.publicKey, 'user-alice', 'user-bob')
    const numberBA = computeSafetyNumber(b.exchange.publicKey, a.exchange.publicKey, 'user-bob', 'user-alice')
    expect(numberAB).toBe(numberBA)
    expect(numberAB.replace(/\s/g, '')).toMatch(/^\d{60}$/)
    expect(numberAB.split(' ')).toHaveLength(12)
  })

  it('differs when either identity is replaced', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const c = generateIdentity()
    const ab = computeSafetyNumber(a.exchange.publicKey, b.exchange.publicKey, 'user-alice', 'user-bob')
    const ac = computeSafetyNumber(a.exchange.publicKey, c.exchange.publicKey, 'user-alice', 'user-carol')
    expect(ab).not.toBe(ac)
  })

  it('differs for the same keys assigned to different user ids', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    const ab = computeSafetyNumber(a.exchange.publicKey, b.exchange.publicKey, 'user-alice', 'user-bob')
    const abSwapped = computeSafetyNumber(a.exchange.publicKey, b.exchange.publicKey, 'user-eve', 'user-bob')
    expect(ab).not.toBe(abSwapped)
  })
})
