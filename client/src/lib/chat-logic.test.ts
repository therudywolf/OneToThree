// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * SECTOR (group_e2e) key distribution round-trip. A group's AES-256 sector key
 * is wrapped per member under ECDH; every member must unwrap to the SAME key,
 * and a non-recipient must NOT be able to unwrap. This path had no unit test —
 * a regression would silently lock members out of (or, worse, leak) group
 * messages. Covers both wrap formats: the ephemeral handshake
 * (`dispatchSectorKeys`) and the creator static-key auth-wrap
 * (`wrapGroupKeyForMemberWithCreatorEcdh`).
 */
import { describe, it, expect } from 'vitest'

import {
  dispatchSectorKeys,
  wrapGroupKeyForMemberWithCreatorEcdh,
  unwrapGroupKeyFromStoredPayload,
} from './chat-logic'
import {
  generateKeyPair,
  exportPublicKey,
  generateAesGcm256Key,
  encryptMessage,
  decryptMessage,
} from './crypto'

type Member = { id: string; priv: CryptoKey; pubJwk: string }

async function makeMember(id: string): Promise<Member> {
  const pair = await generateKeyPair({ extractable: true })
  const pubJwk = await exportPublicKey(pair.publicKey)
  return { id, priv: pair.privateKey, pubJwk }
}

/** Prove two AES-GCM keys are identical via an encrypt-with-one / decrypt-with-other round-trip. */
async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const { ciphertext, iv } = await encryptMessage(a, 'sector-probe-🦊')
  try {
    return (await decryptMessage(b, ciphertext, iv)) === 'sector-probe-🦊'
  } catch {
    return false
  }
}

describe('SECTOR group key distribution', () => {
  it('ephemeral dispatch: every member unwraps to the SAME sector key', async () => {
    const alice = await makeMember('alice')
    const bob = await makeMember('bob')
    const carol = await makeMember('carol')

    const rows = await dispatchSectorKeys([alice.pubJwk, bob.pubJwk, carol.pubJwk])
    expect(rows).toHaveLength(3)

    const rowFor = (m: Member) => rows.find((r) => r.publicKey === m.pubJwk)!.encryptedGroupKeyBase64
    const keyA = await unwrapGroupKeyFromStoredPayload(alice.priv, rowFor(alice))
    const keyB = await unwrapGroupKeyFromStoredPayload(bob.priv, rowFor(bob))
    const keyC = await unwrapGroupKeyFromStoredPayload(carol.priv, rowFor(carol))

    // A message encrypted by one member decrypts for the others → one shared key.
    expect(await sameKey(keyA, keyB)).toBe(true)
    expect(await sameKey(keyA, keyC)).toBe(true)
  })

  it('creator auth-wrap: member recovers the exact creator-provided sector key', async () => {
    const creator = await makeMember('creator')
    const member = await makeMember('member')
    const sectorKey = await generateAesGcm256Key()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      creator.priv,
      member.pubJwk,
      sectorKey,
      creator.pubJwk,
    )
    const recovered = await unwrapGroupKeyFromStoredPayload(member.priv, wrapped)

    expect(await sameKey(sectorKey, recovered)).toBe(true)
  })

  it('per-recipient isolation: neither another member nor a stranger can unwrap a row', async () => {
    const alice = await makeMember('alice')
    const bob = await makeMember('bob')
    const stranger = await makeMember('stranger')

    const rows = await dispatchSectorKeys([alice.pubJwk, bob.pubJwk])
    const aliceRow = rows.find((r) => r.publicKey === alice.pubJwk)!.encryptedGroupKeyBase64

    // Bob is a group member but Alice's row was sealed only for Alice.
    await expect(
      unwrapGroupKeyFromStoredPayload(bob.priv, aliceRow),
    ).rejects.toThrow()
    // An outsider with no row at all.
    await expect(
      unwrapGroupKeyFromStoredPayload(stranger.priv, aliceRow),
    ).rejects.toThrow()
  })

  it('creator auth-wrap is bound to the creator key: a forged creator key cannot unwrap', async () => {
    const creator = await makeMember('creator')
    const member = await makeMember('member')
    const sectorKey = await generateAesGcm256Key()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      creator.priv,
      member.pubJwk,
      sectorKey,
      creator.pubJwk,
    )
    // Tamper the embedded creator public key with an unrelated key → ECDH yields
    // a different wrap key → AES-GCM unseal must fail (no silent wrong key).
    const impostor = await makeMember('impostor')
    const payload = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(wrapped), (c) => c.charCodeAt(0))),
    )
    payload.creatorEcdhPublicKeyJwk = impostor.pubJwk
    const forged = btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))),
    )

    await expect(
      unwrapGroupKeyFromStoredPayload(member.priv, forged),
    ).rejects.toThrow()
  })

  it('dispatch to no members yields no rows', async () => {
    expect(await dispatchSectorKeys([])).toEqual([])
  })

  it('malformed stored payload is rejected', async () => {
    const member = await makeMember('member')
    const garbage = btoa('not-json')
    await expect(
      unwrapGroupKeyFromStoredPayload(member.priv, garbage),
    ).rejects.toThrow()
  })
})
