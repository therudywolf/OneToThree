// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Per-device Double Ratchet round-trip integration test — track A4.
 *
 * Why this file exists
 * --------------------
 * `session-manager.test.ts` mocks the session store so `getSessionRecord`
 * ALWAYS returns null. Persistence is a no-op there: every `encryptForPeer`
 * silently re-bootstraps and the test cannot observe a ratchet desync. That
 * blind spot is exactly how the A4 desync reached production — unit tests were
 * green but no test ever exercised a real encrypt -> wire -> decrypt exchange.
 *
 * This suite installs a REAL in-memory session store and a REAL in-memory
 * X3DH key directory, then drives the public API (`encryptForPeer` /
 * `decryptFromPeer`) through full conversations — sequential, bidirectional,
 * out-of-order, concurrent send, batch decrypt and multi-device fan-out —
 * asserting that EVERY message of a conversation decrypts, not just the first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface StoredRecord {
  id: string
  ownerUserId: string
  ownDeviceId: string
  peerUserId: string
  peerDeviceId: string
  payload: ArrayBuffer
  updatedAt: number
  protocolVersion: number
}

interface DirEntry {
  identitySigning: string
  identityExchange: string
  identityExchangeSignature: string
  generation: number
  spk: { id: number; publicKey: string; signature: string }
  /** One-time prekeys — `fetchBundle` pops one per call, like the real server. */
  otps: Array<{ id: number; publicKey: string }>
}

/** In-memory fakes shared with the `vi.mock` factories (hoisted above imports). */
const fake = vi.hoisted(() => ({
  /** recordId -> session record. recordId = owner::ownDevice::peer::peerDevice. */
  sessions: new Map<string, StoredRecord>(),
  /** userId -> deviceId -> published key-directory entry. */
  keyDir: new Map<string, Map<string, DirEntry>>(),
}))

// A REAL persisting session store — the whole point of this file. Unlike the
// always-null mock in session-manager.test.ts, saved ratchet state is actually
// readable back, so a re-bootstrap or desync becomes observable.
vi.mock('./session-store', () => {
  const recordId = (o: string, od: string, p: string, pd: string) =>
    `${o}::${od}::${p}::${pd}`
  return {
    putSessionRecord: vi.fn(
      async (
        o: string,
        od: string,
        p: string,
        pd: string,
        payload: ArrayBuffer,
        protocolVersion: number
      ) => {
        fake.sessions.set(recordId(o, od, p, pd), {
          id: recordId(o, od, p, pd),
          ownerUserId: o,
          ownDeviceId: od,
          peerUserId: p,
          peerDeviceId: pd,
          payload,
          updatedAt: Date.now(),
          protocolVersion,
        })
      }
    ),
    getSessionRecord: vi.fn(
      async (o: string, od: string, p: string, pd: string) =>
        fake.sessions.get(recordId(o, od, p, pd)) ?? null
    ),
    deleteSessionRecord: vi.fn(
      async (o: string, od: string, p: string, pd: string) => {
        fake.sessions.delete(recordId(o, od, p, pd))
      }
    ),
    deleteSessionRecordsForPeer: vi.fn(async (o: string, p: string) => {
      for (const [k, v] of [...fake.sessions]) {
        if (v.ownerUserId === o && v.peerUserId === p) fake.sessions.delete(k)
      }
    }),
    listSessionPeers: vi.fn(async (o: string) => {
      const peers = new Set<string>()
      for (const v of fake.sessions.values()) {
        if (v.ownerUserId === o) peers.add(v.peerUserId)
      }
      return [...peers]
    }),
  }
})

// A REAL X3DH key directory — every simulated device publishes here, and X3DH
// runs against genuine published key material.
vi.mock('@/lib/api/keys', () => {
  const entry = (userId: string, deviceId: string): DirEntry => {
    const dev = fake.keyDir.get(userId)?.get(deviceId)
    if (!dev) throw new Error(`KEYS_NO_DEVICE:${userId}/${deviceId}`)
    return dev
  }
  const identityOf = (d: DirEntry) => ({
    signing_public_key: d.identitySigning,
    exchange_public_key: d.identityExchange,
    exchange_public_key_signature: d.identityExchangeSignature,
    generation: d.generation,
  })
  return {
    fetchBundle: vi.fn(async (userId: string, deviceId?: string) => {
      const m = fake.keyDir.get(userId)
      const id = deviceId ?? [...(m?.keys() ?? [])].at(-1)
      if (!id) throw new Error(`KEYS_NO_DEVICE:${userId}`)
      const d = entry(userId, id)
      // Pop a one-time prekey, exactly as the server does atomically.
      const otp = d.otps.shift() ?? null
      return {
        user_id: userId,
        identity: identityOf(d),
        signed_prekey: {
          pre_key_id: d.spk.id,
          public_key: d.spk.publicKey,
          signature: d.spk.signature,
        },
        one_time_prekey: otp
          ? { pre_key_id: otp.id, public_key: otp.publicKey }
          : null,
      }
    }),
    fetchDeviceIdentities: vi.fn(async (userId: string) => {
      const m = fake.keyDir.get(userId)
      return {
        user_id: userId,
        devices: m
          ? [...m.entries()].map(([device_id, d]) => ({
              device_id,
              identity: identityOf(d),
            }))
          : [],
      }
    }),
    fetchIdentity: vi.fn(async (userId: string, deviceId?: string) => {
      const m = fake.keyDir.get(userId)
      const id = deviceId ?? [...(m?.keys() ?? [])].at(-1)
      if (!id) throw new Error(`KEYS_NO_DEVICE:${userId}`)
      return {
        user_id: userId,
        device_id: id,
        identity: identityOf(entry(userId, id)),
      }
    }),
    publishIdentity: vi.fn(async () => ({ ok: true })),
    publishSignedPrekey: vi.fn(async () => ({ ok: true })),
    publishOneTimePrekeys: vi.fn(async () => ({ ok: true, stored: 0 })),
    fetchInventory: vi.fn(async () => ({ one_time_prekeys: 0, max: 0 })),
  }
})

import {
  clearDrSession,
  clearOwnDrIdentity,
  decryptFromPeer,
  encodeBase64Url,
  encryptForPeer,
  generateLocalBundle,
  sessionIdentityKeys,
  setOwnDrIdentity,
  setSessionWrapKey,
  type DrDeviceEnvelope,
  type DrFanoutResult,
  type LocalIdentityBundle,
} from './session-manager'
import { computeSafetyNumber } from './safety-number'

interface Device {
  userId: string
  deviceId: string
  bundle: LocalIdentityBundle
  otpDeriver: (id: number) => Uint8Array
}

/** Generate a device identity, publish it to the fake key directory. */
function registerDevice(userId: string, deviceId: string, otpCount = 50): Device {
  const bundle = generateLocalBundle(otpCount)
  let userMap = fake.keyDir.get(userId)
  if (!userMap) {
    userMap = new Map()
    fake.keyDir.set(userId, userMap)
  }
  userMap.set(deviceId, {
    identitySigning: encodeBase64Url(bundle.identity.signing.publicKey),
    identityExchange: encodeBase64Url(bundle.identity.exchange.publicKey),
    identityExchangeSignature: encodeBase64Url(bundle.identityExchangeSignature),
    generation: 1,
    spk: {
      id: bundle.signedPreKey.id,
      publicKey: encodeBase64Url(bundle.signedPreKey.keypair.publicKey),
      signature: encodeBase64Url(bundle.signedPreKey.signature),
    },
    otps: bundle.oneTimePreKeys.map((k) => ({
      id: k.id,
      publicKey: encodeBase64Url(k.keypair.publicKey),
    })),
  })
  return {
    userId,
    deviceId,
    bundle,
    otpDeriver: (id: number) => {
      const k = bundle.oneTimePreKeys.find((o) => o.id === id)
      if (!k) throw new Error(`test: unknown otp id ${id}`)
      return k.keypair.privateKey
    },
  }
}

/** Make the session-manager singleton act as this device (vault-unlock sim). */
function actAs(d: Device): void {
  setOwnDrIdentity(
    d.bundle.identity,
    d.bundle.signedPreKey.keypair,
    d.bundle.signedPreKey.id,
    d.deviceId,
    d.otpDeriver
  )
}

/** Encrypt from `d` to every device of `toUserId` (real per-device fan-out). */
async function sendFrom(
  d: Device,
  toUserId: string,
  text: string
): Promise<DrFanoutResult> {
  actAs(d)
  return encryptForPeer(d.userId, toUserId, text)
}

/** Extract the wire envelope addressed to one recipient device. */
function envelopeFor(result: DrFanoutResult, deviceId: string): DrDeviceEnvelope {
  const slot = result.slots.find((s) => s.deviceId === deviceId)
  if (!slot) throw new Error(`test: fan-out produced no slot for ${deviceId}`)
  return JSON.parse(slot.envelope) as DrDeviceEnvelope
}

/**
 * Decrypt an envelope on device `d`. `fromUserId` is the ACTUAL sender's user
 * id — for a self-sync copy that is the receiver's own user id, not the chat
 * peer (this is the routing the transport layer gets wrong).
 */
async function receiveOn(
  d: Device,
  fromUserId: string,
  env: DrDeviceEnvelope
): Promise<string> {
  actAs(d)
  return decryptFromPeer(d.userId, fromUserId, env)
}

describe('per-device Double Ratchet round-trip (A4)', () => {
  beforeEach(async () => {
    fake.sessions.clear()
    fake.keyDir.clear()
    clearOwnDrIdentity()
    const wrapKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
    setSessionWrapKey(wrapKey as CryptoKey)
  })

  afterEach(() => {
    clearOwnDrIdentity()
  })

  it('1<->1 sequential one-directional: every message decrypts, not just the first', async () => {
    const alice = registerDevice('alice', 'alice-1')
    const bob = registerDevice('bob', 'bob-1')

    for (let i = 1; i <= 5; i += 1) {
      const sent = await sendFrom(alice, 'bob', `msg-${i}`)
      const plain = await receiveOn(bob, 'alice', envelopeFor(sent, 'bob-1'))
      expect(plain).toBe(`msg-${i}`)
    }
  })

  it('1<->1 bidirectional conversation across multiple DH ratchet steps', async () => {
    const alice = registerDevice('alice', 'alice-1')
    const bob = registerDevice('bob', 'bob-1')

    const aToB = async (text: string) =>
      receiveOn(bob, 'alice', envelopeFor(await sendFrom(alice, 'bob', text), 'bob-1'))
    const bToA = async (text: string) =>
      receiveOn(alice, 'bob', envelopeFor(await sendFrom(bob, 'alice', text), 'alice-1'))

    expect(await aToB('a1')).toBe('a1')
    expect(await bToA('b1')).toBe('b1')
    expect(await aToB('a2')).toBe('a2')
    expect(await aToB('a3')).toBe('a3')
    expect(await bToA('b2')).toBe('b2')
    expect(await bToA('b3')).toBe('b3')
    expect(await aToB('a4')).toBe('a4')
  })

  it('tolerates out-of-order delivery within one sending chain', async () => {
    const alice = registerDevice('alice', 'alice-1')
    const bob = registerDevice('bob', 'bob-1')

    const envs: DrDeviceEnvelope[] = []
    for (let i = 0; i < 4; i += 1) {
      envs.push(envelopeFor(await sendFrom(alice, 'bob', `m${i}`), 'bob-1'))
    }
    // Deliver shuffled: 2, 0, 3, 1.
    expect(await receiveOn(bob, 'alice', envs[2])).toBe('m2')
    expect(await receiveOn(bob, 'alice', envs[0])).toBe('m0')
    expect(await receiveOn(bob, 'alice', envs[3])).toBe('m3')
    expect(await receiveOn(bob, 'alice', envs[1])).toBe('m1')
  })

  it('CONCURRENT SEND: two messages sent without awaiting the first both decrypt', async () => {
    const alice = registerDevice('alice', 'alice-1')
    const bob = registerDevice('bob', 'bob-1')

    // The send hook fires one encryptForPeer per dispatch; two rapid sends race.
    // Neither has persisted its session when the other calls loadSession.
    actAs(alice)
    const [r1, r2] = await Promise.all([
      encryptForPeer('alice', 'bob', 'concurrent-1'),
      encryptForPeer('alice', 'bob', 'concurrent-2'),
    ])

    expect(await receiveOn(bob, 'alice', envelopeFor(r1, 'bob-1'))).toBe('concurrent-1')
    expect(await receiveOn(bob, 'alice', envelopeFor(r2, 'bob-1'))).toBe('concurrent-2')
  })

  it('BATCH DECRYPT: a backlog decrypted concurrently (Promise.all) all succeeds', async () => {
    const alice = registerDevice('alice', 'alice-1')
    const bob = registerDevice('bob', 'bob-1')

    const envs: DrDeviceEnvelope[] = []
    for (let i = 0; i < 4; i += 1) {
      envs.push(envelopeFor(await sendFrom(alice, 'bob', `batch-${i}`), 'bob-1'))
    }
    // decryptApiMessageRows decrypts a pending backlog with Promise.all(map).
    // allSettled so a reproduction failure cannot leave a floating promise
    // that mutates the store after the next test's beforeEach has cleared it.
    actAs(bob)
    const settled = await Promise.allSettled(
      envs.map((e) => decryptFromPeer('bob', 'alice', e))
    )
    const out = settled.map((r) =>
      r.status === 'fulfilled' ? r.value : `[FAIL:${(r.reason as Error).message}]`
    )
    expect(out).toEqual(['batch-0', 'batch-1', 'batch-2', 'batch-3'])
  })

  it('MULTI-DEVICE fan-out: peer device and self-sync device both decrypt every message', async () => {
    const alice1 = registerDevice('alice', 'alice-1')
    const alice2 = registerDevice('alice', 'alice-2')
    const bob1 = registerDevice('bob', 'bob-1')

    // alice-1 sends; fan-out must address bob-1 AND the sender's own alice-2.
    const first = await sendFrom(alice1, 'bob', 'hello')
    expect(await receiveOn(bob1, 'alice', envelopeFor(first, 'bob-1'))).toBe('hello')
    expect(await receiveOn(alice2, 'alice', envelopeFor(first, 'alice-2'))).toBe('hello')

    // Second message — a per-device desync surfaces here.
    const second = await sendFrom(alice1, 'bob', 'world')
    expect(await receiveOn(bob1, 'alice', envelopeFor(second, 'bob-1'))).toBe('world')
    expect(await receiveOn(alice2, 'alice', envelopeFor(second, 'alice-2'))).toBe('world')
  })

  it('SAFETY NUMBER: both sides of one session read out the SAME digits', async () => {
    const alice = registerDevice('alice', 'alice-1')
    const bob = registerDevice('bob', 'bob-1')

    // Establish the session in both directions so each side has a record.
    const sent = await sendFrom(alice, 'bob', 'hi')
    expect(await receiveOn(bob, 'alice', envelopeFor(sent, 'bob-1'))).toBe('hi')

    // Compute the number exactly as identity-modal does, once per side.
    actAs(alice)
    const aKeys = await sessionIdentityKeys('alice', 'bob', 'bob-1')
    actAs(bob)
    const bKeys = await sessionIdentityKeys('bob', 'alice', 'alice-1')
    if (!aKeys || !bKeys) throw new Error('test: no session identity keys')

    // Each side supplies (ownKey, peerKey) in ITS OWN order — the whole point
    // of the safety number is that the two orderings agree. Hashing them
    // local-then-remote before calling computeSafetyNumber (what the old
    // `sessionFingerprint` did) made this impossible on a clean session.
    const aNumber = computeSafetyNumber(aKeys.own, aKeys.peer, 'alice', 'bob')
    const bNumber = computeSafetyNumber(bKeys.own, bKeys.peer, 'bob', 'alice')
    expect(aNumber).toBe(bNumber)
    expect(aNumber.replace(/\s/g, '')).toMatch(/^\d{60}$/)

    // Sanity: the keys really are the two distinct identity-signing keys.
    expect(encodeBase64Url(aKeys.own)).toBe(
      encodeBase64Url(alice.bundle.identity.signing.publicKey)
    )
    expect(encodeBase64Url(aKeys.peer)).toBe(
      encodeBase64Url(bob.bundle.identity.signing.publicKey)
    )
  })

  it('TOFU RESET: a peer that re-runs X3DH is adopted, and pre-reset messages still decrypt', async () => {
    const alice = registerDevice('alice', 'alice-1')
    const bob = registerDevice('bob', 'bob-1')

    // PENDING_INIT_MAX_RESENDS sends carry the same dr_init; after that the
    // handshake metadata is dropped, which is the realistic state for a message
    // that then sits unsent in the outbox.
    for (let i = 1; i <= 3; i += 1) {
      const m = await sendFrom(alice, 'bob', `before-${i}`)
      expect(await receiveOn(bob, 'alice', envelopeFor(m, 'bob-1'))).toBe(`before-${i}`)
    }

    // Sent before the reset, still sitting in /sync/pending when it happens.
    const inFlight = envelopeFor(await sendFrom(alice, 'bob', 'in-flight'), 'bob-1')
    expect(inFlight.i).toBeUndefined()

    // Alice clicks "Accept new key & reset session" — that clears only HER
    // records, so her next send is a brand-new X3DH handshake while Bob still
    // holds the old one. Bob used to ignore the new dr_init and stay on the
    // dead root key, silently failing every later message forever.
    actAs(alice)
    await clearDrSession('alice', 'bob')

    const after = await sendFrom(alice, 'bob', 'after-reset')
    expect(await receiveOn(bob, 'alice', envelopeFor(after, 'bob-1'))).toBe('after-reset')

    // The superseded ratchet is archived, not dropped.
    expect(await receiveOn(bob, 'alice', inFlight)).toBe('in-flight')

    // And the new session keeps working afterwards.
    const later = await sendFrom(alice, 'bob', 'after-reset-2')
    expect(await receiveOn(bob, 'alice', envelopeFor(later, 'bob-1'))).toBe('after-reset-2')
  })

  // Regression: adopting a new handshake must not make a LATE message carrying
  // the OLD one resurrect it. /sync/pending delivers out of order, so an
  // envelope minted before the reset can land after it. Re-running X3DH against
  // that dead handshake rolled `session.ratchet` back to a root key the peer had
  // already destroyed — inbound kept working via archivedRatchets, so nothing
  // looked wrong, while every message Bob SENT from then on was permanently
  // undecryptable for Alice.
  it('TOFU RESET: a late message carrying the SUPERSEDED handshake does not revert the session', async () => {
    const alice = registerDevice('alice', 'alice-1')
    const bob = registerDevice('bob', 'bob-1')

    // First handshake, and an envelope from it left undelivered.
    const first = await sendFrom(alice, 'bob', 'old-1')
    expect(await receiveOn(bob, 'alice', envelopeFor(first, 'bob-1'))).toBe('old-1')
    const strandedOld = envelopeFor(await sendFrom(alice, 'bob', 'old-2'), 'bob-1')

    // Alice resets and Bob adopts the new handshake.
    actAs(alice)
    await clearDrSession('alice', 'bob')
    const fresh = await sendFrom(alice, 'bob', 'new-1')
    expect(await receiveOn(bob, 'alice', envelopeFor(fresh, 'bob-1'))).toBe('new-1')

    // Now the stranded pre-reset envelope finally arrives. It must still decrypt
    // (archived ratchet) but must NOT become the live session again.
    expect(await receiveOn(bob, 'alice', strandedOld)).toBe('old-2')

    // The proof: Bob's SEND direction still lands on the handshake Alice holds.
    const reply = await sendFrom(bob, 'alice', 'bob-reply')
    expect(await receiveOn(alice, 'bob', envelopeFor(reply, 'alice-1'))).toBe('bob-reply')

    // ...and Alice can still reach Bob on the new session afterwards.
    const more = await sendFrom(alice, 'bob', 'new-2')
    expect(await receiveOn(bob, 'alice', envelopeFor(more, 'bob-1'))).toBe('new-2')
  })
})
