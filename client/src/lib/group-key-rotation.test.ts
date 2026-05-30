// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Group key rotation decision logic (`shouldRotateGroupKey`). The full
 * crypto round-trip — fresh key, per-member wrap, removed-member exclusion —
 * is covered in `chat-logic.test.ts`. Here we lock the GUARD that decides when
 * the owner mints a new key, since a wrong guard either skips rotation (no
 * forward secrecy) or rotates on every render (churn).
 */
import { describe, it, expect } from 'vitest'

import { shouldRotateGroupKey } from './group-key-rotation'
import {
  wrapGroupKeyForMemberWithCreatorEcdh,
} from './chat-logic'
import {
  generateKeyPair,
  exportPublicKey,
  generateAesGcm256Key,
} from './crypto'
import type { ChatDetailPayload, ChatMemberRole } from '@/lib/api/chats'

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

  it('owner with no stored key yet → do NOT rotate (nothing to base a key on)', async () => {
    const d = detail('owner', 'group_e2e', [await member('me', 'owner', null)])
    expect(shouldRotateGroupKey(d, 'me', 1)).toBe(false)
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
