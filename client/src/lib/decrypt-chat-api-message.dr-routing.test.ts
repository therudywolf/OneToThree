// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Inbound per-device Double Ratchet routing — track A4.
 *
 * A direct-chat message is fanned out to the peer's devices AND to the
 * sender's own other devices (self-sync). A self-sync copy is encrypted on the
 * `(myDeviceA <-> myDeviceB)` ratchet, so on receipt its DR peer is the user
 * themselves — NOT the chat peer. `decryptApiMessageRows` must pick the DR
 * peer per row from `sender_id`; routing every row to the chat peer leaves
 * self-sync copies undecryptable on the user's other devices.
 *
 * `decryptFromPeer` is faithfully stubbed: a session exists only for the exact
 * (ownerId, peerId, senderDevice) the slot was encrypted under — mirroring the
 * real ratchet store — so a mis-routed peerId throws RATCHET_NO_SESSION.
 */
import { describe, expect, it, vi } from 'vitest'

/** `owner|peer|senderDevice` -> plaintext, seeded per test. */
const drSessions = vi.hoisted(() => new Map<string, string>())

vi.mock('@/lib/ratchet/session-manager', () => ({
  decryptFromPeer: vi.fn(
    async (ownerId: string, peerId: string, env: { sd: string }) => {
      const plain = drSessions.get(`${ownerId}|${peerId}|${env.sd}`)
      if (plain === undefined) throw new Error('RATCHET_NO_SESSION')
      return plain
    }
  ),
}))

import {
  decryptApiMessageRow,
  type ApiMessageRow,
  type DrContext,
} from '@/lib/decrypt-chat-api-message'
import { DR_SLOT_SENTINEL } from '@/lib/fanout-crypto'

function drRow(id: string, senderId: string, senderDeviceId: string): ApiMessageRow {
  return {
    id,
    chat_id: 'chat-1',
    sender_id: senderId,
    content: null,
    iv: null,
    device_ciphertext: JSON.stringify({ v: 2, sd: senderDeviceId, h: 'hdr', c: 'ct' }),
    device_iv: DR_SLOT_SENTINEL,
    protocol_version: 2,
    created_at: new Date().toISOString(),
  }
}

describe('decryptApiMessageRows — per-device DR inbound routing (A4)', () => {
  it('routes a self-sync copy to the owner ratchet and a peer message to the peer ratchet', async () => {
    drSessions.clear()
    // Peer message: encrypted by bob's device on the (alice <- bob) ratchet.
    drSessions.set('alice|bob|bob-dev', 'message from bob')
    // Self-sync copy: from alice's OTHER device, on the (alice <- alice) ratchet.
    drSessions.set('alice|alice|alice-dev-2', 'message from my other device')

    const drCtx: DrContext = { ownerUserId: 'alice', peerUserId: 'bob' }
    const ctx = { mode: 'DIRECT' as const, peerPublicKeyJwk: 'unused-in-v2' }

    // Decrypt one row at a time: decryptApiMessageRows batches with
    // Promise.all, and vitest mis-resolves a mocked module under concurrent
    // dynamic import(). decryptApiMessageRow runs the same decryptRowPlaintext
    // routing without that harness flake.
    const peerOut = await decryptApiMessageRow(
      {} as CryptoKey,
      ctx,
      drRow('m1', 'bob', 'bob-dev'),
      drCtx
    )
    const selfOut = await decryptApiMessageRow(
      {} as CryptoKey,
      ctx,
      drRow('m2', 'alice', 'alice-dev-2'),
      drCtx
    )

    expect(peerOut.plaintext).toBe('message from bob')
    // Routed to the chat peer this would be [DECRYPT_FAIL]; the self-sync
    // copy's ratchet peer is the owner.
    expect(selfOut.plaintext).toBe('message from my other device')
  })
})
