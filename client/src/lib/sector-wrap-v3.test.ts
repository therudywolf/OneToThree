// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Backlog #1 — the sector key wrap must authenticate its own context.
 *
 * A v2 wrap authenticated only its ciphertext. The epoch sat in a plaintext JSON
 * field the AEAD never covered, and nothing recorded which chat or which member
 * the blob was for — so an old wrapped key could be re-served with a newer epoch
 * stamped on it and the member would adopt a key the group had already rotated
 * away from, handing a departed member back exactly the traffic that rotation
 * was meant to lock them out of.
 *
 * v3 binds chat + epoch + creator + member as AES-GCM additionalData, so
 * tampering with any of them makes the unseal fail instead of succeeding with a
 * lie attached.
 */
import { describe, expect, it } from 'vitest'
import {
  unwrapGroupKeyFromStoredPayload,
  wrapGroupKeyForMemberWithCreatorEcdh,
} from './chat-logic'
import { exportPublicKey, generateKeyPair } from './crypto'

const CHAT = '11111111-1111-4111-8111-111111111111'
const OTHER_CHAT = '22222222-2222-4222-8222-222222222222'
const MEMBER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function party() {
  const kp = await generateKeyPair({ curve: 'P-256' })
  return { priv: kp.privateKey, pub: await exportPublicKey(kp.publicKey) }
}

async function sectorKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}

async function raw(k: CryptoKey) {
  return Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', k))).toString('hex')
}

/** Re-stamp a packed payload's plaintext fields, as a hostile server would. */
function tamper(packed: string, patch: Record<string, unknown>): string {
  const json = JSON.parse(Buffer.from(packed, 'base64').toString('utf8')) as Record<string, unknown>
  return Buffer.from(JSON.stringify({ ...json, ...patch }), 'utf8').toString('base64')
}

describe('sector key wrap v3 — context binding', () => {
  it('round-trips when the reader supplies the same context', async () => {
    const owner = await party()
    const member = await party()
    const key = await sectorKey()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, member.pub, key, owner.pub, 7, { chatId: CHAT, memberUserId: MEMBER }
    )
    const out = await unwrapGroupKeyFromStoredPayload(
      member.priv, wrapped, owner.pub, { chatId: CHAT, memberUserId: MEMBER }
    )
    expect(await raw(out)).toBe(await raw(key))
  })

  // THE regression: re-stamping the epoch must break the seal.
  it('refuses a wrap whose epoch has been re-stamped', async () => {
    const owner = await party()
    const member = await party()
    const key = await sectorKey()

    const atEpoch3 = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, member.pub, key, owner.pub, 3, { chatId: CHAT, memberUserId: MEMBER }
    )
    const replayedAs7 = tamper(atEpoch3, { epoch: 7 })

    await expect(
      unwrapGroupKeyFromStoredPayload(member.priv, replayedAs7, owner.pub, {
        chatId: CHAT,
        memberUserId: MEMBER,
      })
    ).rejects.toThrow()
  })

  it('refuses a wrap replayed into a different chat', async () => {
    const owner = await party()
    const member = await party()
    const key = await sectorKey()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, member.pub, key, owner.pub, 1, { chatId: CHAT, memberUserId: MEMBER }
    )
    await expect(
      unwrapGroupKeyFromStoredPayload(member.priv, wrapped, owner.pub, {
        chatId: OTHER_CHAT,
        memberUserId: MEMBER,
      })
    ).rejects.toThrow(/CONTEXT_MISMATCH/)

    // ...and re-stamping the chat id to match does not help, because the id is
    // inside the AAD as well as in the clear.
    await expect(
      unwrapGroupKeyFromStoredPayload(
        member.priv, tamper(wrapped, { chatId: OTHER_CHAT }), owner.pub,
        { chatId: OTHER_CHAT, memberUserId: MEMBER }
      )
    ).rejects.toThrow()
  })

  it('refuses a wrap addressed to a different member', async () => {
    const owner = await party()
    const member = await party()
    const key = await sectorKey()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, member.pub, key, owner.pub, 1, { chatId: CHAT, memberUserId: MEMBER }
    )
    await expect(
      unwrapGroupKeyFromStoredPayload(member.priv, wrapped, owner.pub, {
        chatId: CHAT,
        memberUserId: OTHER_MEMBER,
      })
    ).rejects.toThrow(/CONTEXT_MISMATCH/)
  })

  it('refuses to open a v3 wrap at all when the reader has no context', async () => {
    const owner = await party()
    const member = await party()
    const key = await sectorKey()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, member.pub, key, owner.pub, 1, { chatId: CHAT, memberUserId: MEMBER }
    )
    await expect(
      unwrapGroupKeyFromStoredPayload(member.priv, wrapped, owner.pub)
    ).rejects.toThrow(/REQUIRES_BINDING/)
  })

  // Creation-time keys are minted before the chat id exists, so they stay v2 and
  // must keep working — they are epoch 0 and get replaced on the first rotation.
  it('still round-trips a v2 wrap (group creation)', async () => {
    const owner = await party()
    const member = await party()
    const key = await sectorKey()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, member.pub, key, owner.pub
    )
    const out = await unwrapGroupKeyFromStoredPayload(member.priv, wrapped, owner.pub)
    expect(await raw(out)).toBe(await raw(key))
  })
})
