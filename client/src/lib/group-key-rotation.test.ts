// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Group key rotation: the decision GUARD (`shouldRotateGroupKey`) and the
 * end-to-end rotation orchestration (`rotateGroupKeyForChat`).
 *
 * The guard matters because a wrong answer either skips rotation (no forward
 * secrecy) or rotates on every render (churn). The orchestration test exercises
 * the real crypto — fresh key, per-member ECDH wrap, owner self-target, epoch
 * stamping, removed-member exclusion — with only the network layer mocked, so a
 * regression in member iteration / wrap construction / upload is caught here
 * rather than in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { shouldRotateGroupKey, rotateGroupKeyForChat } from './group-key-rotation'
import {
  wrapGroupKeyForMemberWithCreatorEcdh,
  unwrapGroupKeyFromStoredPayload,
  readStoredSectorKeyEpoch,
} from './chat-logic'
import {
  generateKeyPair,
  generateKeyPairIsolated,
  exportPublicKey,
  generateAesGcm256Key,
  encryptMessage,
  decryptMessage,
} from './crypto'
import { fetchChatDetail, uploadMemberWrappedGroupKey } from '@/lib/api/chats'
import type { ChatDetailPayload, ChatMemberRole } from '@/lib/api/chats'

vi.mock('@/lib/api/chats', () => ({
  fetchChatDetail: vi.fn(),
  uploadMemberWrappedGroupKey: vi.fn(),
}))

async function member(id: string, role: ChatMemberRole, storedKey: string | null) {
  return {
    user_id: id,
    username: id,
    ecdh_public_key_jwk: 'x',
    encrypted_group_key: storedKey,
    role,
  }
}

function detail(
  myRole: ChatMemberRole,
  type: string,
  members: ChatDetailPayload['members']
): ChatDetailPayload {
  return {
    chat: {
      id: 'c1', name: 'g', type, is_group: true,
      invite_code: null, invite_one_time: null, my_role: myRole,
    },
    members,
  }
}

/** Mint a real stored wrapped key at a given epoch for member `m`. */
async function storedKeyAtEpoch(
  ownerPriv: CryptoKey, ownerPub: string, memberPub: string, epoch: number | undefined
): Promise<string> {
  const sectorKey = await generateAesGcm256Key()
  return wrapGroupKeyForMemberWithCreatorEcdh(ownerPriv, memberPub, sectorKey, ownerPub, epoch)
}

/** Prove two AES-GCM keys are identical via an encrypt-with-one / decrypt-with-other round-trip. */
async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const { ciphertext, iv } = await encryptMessage(a, 'rotation-probe-🦊')
  try {
    return (await decryptMessage(b, ciphertext, iv)) === 'rotation-probe-🦊'
  } catch {
    return false
  }
}

describe('shouldRotateGroupKey', () => {
  it('owner with a stale key (stored epoch < current) → rotate', async () => {
    const owner = await generateKeyPair({ extractable: true })
    const ownerPub = await exportPublicKey(owner.publicKey)
    const stored = await storedKeyAtEpoch(owner.privateKey, ownerPub, ownerPub, 0)
    const d = detail('owner', 'group_e2e', [await member('me', 'owner', stored)])
    expect(shouldRotateGroupKey(d, 'me', 1)).toBe(true)
  })

  it('owner whose key already matches the current epoch → do NOT rotate', async () => {
    const owner = await generateKeyPair({ extractable: true })
    const ownerPub = await exportPublicKey(owner.publicKey)
    const stored = await storedKeyAtEpoch(owner.privateKey, ownerPub, ownerPub, 2)
    const d = detail('owner', 'group_e2e', [await member('me', 'owner', stored)])
    expect(shouldRotateGroupKey(d, 'me', 2)).toBe(false)
  })

  it('a non-owner is never the rotator, even with a stale key', async () => {
    const owner = await generateKeyPair({ extractable: true })
    const ownerPub = await exportPublicKey(owner.publicKey)
    const stored = await storedKeyAtEpoch(owner.privateKey, ownerPub, ownerPub, 0)
    const d = detail('admin', 'group_e2e', [await member('me', 'admin', stored)])
    expect(shouldRotateGroupKey(d, 'me', 5)).toBe(false)
  })

  it('non-group chats never rotate', async () => {
    const d = detail('owner', 'direct_e2e', [await member('me', 'owner', 'k')])
    expect(shouldRotateGroupKey(d, 'me', 9)).toBe(false)
  })

  it('owner with no stored key at epoch 0 (group creation) → do NOT rotate', async () => {
    const d = detail('owner', 'group_e2e', [await member('me', 'owner', null)])
    expect(shouldRotateGroupKey(d, 'me', 0)).toBe(false)
  })

  it('owner with no stored key but the epoch advanced (departure) → rotate (forward secrecy)', async () => {
    // An owner promoted mid-group without a key must still mint the post-departure
    // key — rotation generates a fresh key, so the missing old key is no blocker.
    const d = detail('owner', 'group_e2e', [await member('me', 'owner', null)])
    expect(shouldRotateGroupKey(d, 'me', 1)).toBe(true)
  })

  it('owner whose stored key is unparseable (null epoch) → rotate (fail-forward)', async () => {
    const d = detail('owner', 'group_e2e', [await member('me', 'owner', 'not-a-valid-blob')])
    expect(shouldRotateGroupKey(d, 'me', 1)).toBe(true)
  })

  it('a creation-time epoch-less key at current epoch 0 → do NOT rotate', async () => {
    const owner = await generateKeyPair({ extractable: true })
    const ownerPub = await exportPublicKey(owner.publicKey)
    const stored = await storedKeyAtEpoch(owner.privateKey, ownerPub, ownerPub, undefined)
    const d = detail('owner', 'group_e2e', [await member('me', 'owner', stored)])
    expect(shouldRotateGroupKey(d, 'me', 0)).toBe(false)
  })
})

describe('rotateGroupKeyForChat — end-to-end rotation round-trip', () => {
  type EcdhMember = { id: string; role: ChatMemberRole; priv: CryptoKey; pubJwk: string }

  async function ecdhMember(id: string, role: ChatMemberRole): Promise<EcdhMember> {
    const kp = await generateKeyPair({ extractable: true })
    const pubJwk = await exportPublicKey(kp.publicKey)
    return { id, role, priv: kp.privateKey, pubJwk }
  }

  function mockDetail(
    myRole: ChatMemberRole,
    keyEpoch: number,
    members: Array<{ id: string; role: ChatMemberRole; ecdh: string | null }>
  ): ChatDetailPayload {
    return {
      chat: {
        id: 'g1', name: 'g', type: 'group_e2e', is_group: true,
        invite_code: null, invite_one_time: null, my_role: myRole, key_epoch: keyEpoch,
      },
      members: members.map((m) => ({
        user_id: m.id, username: m.id,
        ecdh_public_key_jwk: m.ecdh,
        encrypted_group_key: null,
        role: m.role,
      })),
    }
  }

  beforeEach(() => {
    vi.mocked(fetchChatDetail).mockReset()
    vi.mocked(uploadMemberWrappedGroupKey).mockReset()
  })

  it('every staying member converges on ONE fresh key at the new epoch; a departed member cannot reach it', async () => {
    const owner = await ecdhMember('owner', 'owner')
    const alice = await ecdhMember('alice', 'member')
    const bob = await ecdhMember('bob', 'member')
    // Carol left — she is NOT in the post-departure member list the owner rotates over.
    const carol = await ecdhMember('carol', 'member')
    const targetEpoch = 1

    // Carol's pre-rotation key (epoch 0), wrapped under the OLD sector key.
    const oldSectorKey = await generateAesGcm256Key()
    const carolOldWrap = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, carol.pubJwk, oldSectorKey, owner.pubJwk,
    )

    vi.mocked(fetchChatDetail).mockResolvedValue(
      mockDetail('owner', targetEpoch, [
        { id: 'owner', role: 'owner', ecdh: owner.pubJwk },
        { id: 'alice', role: 'member', ecdh: alice.pubJwk },
        { id: 'bob', role: 'member', ecdh: bob.pubJwk },
      ])
    )
    const uploaded = new Map<string, string>()
    vi.mocked(uploadMemberWrappedGroupKey).mockImplementation(
      async (_chatId: string, userId: string, wrapped: string) => {
        uploaded.set(userId, wrapped)
      }
    )

    const res = await rotateGroupKeyForChat('g1', owner.id, owner.priv, targetEpoch)

    expect(res).toEqual({ rotated: true, epoch: targetEpoch, members: 3 })
    // Every staying member — INCLUDING the owner self-target — received a key.
    expect([...uploaded.keys()].sort()).toEqual(['alice', 'bob', 'owner'])

    // Each staying member unwraps to the SAME fresh key, stamped at the new epoch.
    const ownerKey = await unwrapGroupKeyFromStoredPayload(owner.priv, uploaded.get('owner')!)
    const aliceKey = await unwrapGroupKeyFromStoredPayload(alice.priv, uploaded.get('alice')!)
    const bobKey = await unwrapGroupKeyFromStoredPayload(bob.priv, uploaded.get('bob')!)
    expect(await sameKey(ownerKey, aliceKey)).toBe(true)
    expect(await sameKey(aliceKey, bobKey)).toBe(true)
    expect(readStoredSectorKeyEpoch(uploaded.get('alice')!)).toBe(targetEpoch)
    expect(readStoredSectorKeyEpoch(uploaded.get('owner')!)).toBe(targetEpoch)

    // It is a genuinely NEW key — not the pre-rotation one.
    expect(await sameKey(ownerKey, oldSectorKey)).toBe(false)

    // Forward secrecy: Carol holds only her stale wrap; there is no row for the
    // new key, and her old wrap decrypts to the OLD key — never the rotated one.
    expect(uploaded.has('carol')).toBe(false)
    const carolRecovered = await unwrapGroupKeyFromStoredPayload(carol.priv, carolOldWrap)
    expect(await sameKey(carolRecovered, ownerKey)).toBe(false)
  })

  it('bails when the OWNER itself has no ECDH key in the roster (cannot bind the wrap)', async () => {
    const owner = await ecdhMember('owner', 'owner')
    vi.mocked(fetchChatDetail).mockResolvedValue(
      mockDetail('owner', 1, [{ id: 'owner', role: 'owner', ecdh: null }])
    )
    vi.mocked(uploadMemberWrappedGroupKey).mockResolvedValue(undefined as unknown as void)
    const res = await rotateGroupKeyForChat('g1', owner.id, owner.priv, 1)
    // The owner's own public key is what every wrap is bound to (D2), so without
    // it nothing can be minted at all — a more precise answer than the old
    // "nobody could receive".
    expect(res).toEqual({ rotated: false, reason: 'NO_OWNER_ECDH_IN_ROSTER' })
    expect(uploadMemberWrappedGroupKey).not.toHaveBeenCalled()
  })

  it('skips members without an ECDH key and reports NO_MEMBERS_DELIVERED when none can receive', async () => {
    const owner = await ecdhMember('owner', 'owner')
    vi.mocked(fetchChatDetail).mockResolvedValue(
      mockDetail('owner', 1, [
        { id: 'owner', role: 'owner', ecdh: owner.pubJwk },
        { id: 'keyless', role: 'member', ecdh: null },
      ])
    )
    vi.mocked(uploadMemberWrappedGroupKey).mockResolvedValue(undefined as unknown as void)
    const res = await rotateGroupKeyForChat('g1', 'nobody-in-roster', owner.priv, 1)
    expect(res).toEqual({ rotated: false, reason: 'NO_OWNER_ECDH_IN_ROSTER' })
    expect(uploadMemberWrappedGroupKey).not.toHaveBeenCalled()
  })

  /**
   * REGRESSION: the vault private key is imported NON-EXTRACTABLE (Stage-1 key
   * isolation), which is the ONLY state it ever has in production. Rotation used
   * to derive the owner's public key via exportKey('jwk', priv) — that throws
   * InvalidAccessError on such a key, and the error was swallowed by a catch, so
   * rotation and owner-side key delivery never worked at all: a departing member
   * kept reading new traffic and a newly added member never received any key.
   * Every previous test passed only because its fixtures used extractable keys.
   */
  it('rotates with a NON-EXTRACTABLE owner private key (the production case)', async () => {
    // Exactly how the vault holds it: a non-extractable private CryptoKey.
    const iso = await generateKeyPairIsolated()
    const ownerPubJwk = iso.publicJwk
    const nonExtractablePriv = iso.privateKey
    expect(nonExtractablePriv.extractable).toBe(false)

    const bob = await ecdhMember('bob', 'member')
    vi.mocked(fetchChatDetail).mockResolvedValue(
      mockDetail('owner', 3, [
        { id: 'owner', role: 'owner', ecdh: ownerPubJwk },
        { id: 'bob', role: 'member', ecdh: bob.pubJwk },
      ])
    )
    const uploaded = new Map<string, string>()
    vi.mocked(uploadMemberWrappedGroupKey).mockImplementation(async (_c, uid, blob) => {
      uploaded.set(uid, blob)
    })

    const res = await rotateGroupKeyForChat('g1', 'owner', nonExtractablePriv, 3)
    expect(res).toEqual({ rotated: true, epoch: 3, members: 2 })

    // Bob really can open the rotated key, and it is bound to the owner.
    const bobKey = await unwrapGroupKeyFromStoredPayload(bob.priv, uploaded.get('bob')!, ownerPubJwk)
    const ownerKey = await unwrapGroupKeyFromStoredPayload(
      nonExtractablePriv, uploaded.get('owner')!, ownerPubJwk
    )
    expect(await sameKey(bobKey, ownerKey)).toBe(true)
    expect(readStoredSectorKeyEpoch(uploaded.get('bob')!)).toBe(3)
  })

  it('refuses to rotate when we are not the owner', async () => {
    const me = await ecdhMember('me', 'admin')
    vi.mocked(fetchChatDetail).mockResolvedValue(
      mockDetail('admin', 1, [{ id: 'me', role: 'admin', ecdh: me.pubJwk }])
    )
    const res = await rotateGroupKeyForChat('g1', me.id, me.priv, 1)
    expect(res).toEqual({ rotated: false, reason: 'NOT_OWNER' })
    expect(uploadMemberWrappedGroupKey).not.toHaveBeenCalled()
  })
})
