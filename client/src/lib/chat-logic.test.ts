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
  readStoredSectorKeyEpoch,
  ecdhPublicKeysEqual,
} from './chat-logic'
import {
  generateKeyPair,
  exportPublicKey,
  exportEcdhPublicJwkFromPrivateKey,
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

describe('SECTOR key rotation: epoch stamping', () => {
  it('round-trips an epoch-stamped key: unwraps to the same key and reports its epoch', async () => {
    const creator = await makeMember('creator')
    const member = await makeMember('member')
    const sectorKey = await generateAesGcm256Key()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      creator.priv,
      member.pubJwk,
      sectorKey,
      creator.pubJwk,
      3,
    )

    // The epoch is readable WITHOUT the private key (plaintext metadata)...
    expect(readStoredSectorKeyEpoch(wrapped)).toBe(3)
    // ...and the sealed key still recovers correctly.
    const recovered = await unwrapGroupKeyFromStoredPayload(member.priv, wrapped)
    expect(await sameKey(sectorKey, recovered)).toBe(true)
  })

  it('a creation-time (epoch-less) auth-wrap reads back as epoch 0', async () => {
    const creator = await makeMember('creator')
    const member = await makeMember('member')
    const sectorKey = await generateAesGcm256Key()

    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      creator.priv,
      member.pubJwk,
      sectorKey,
      creator.pubJwk,
    )
    expect(readStoredSectorKeyEpoch(wrapped)).toBe(0)
  })

  it('an ephemeral-dispatch row (legacy format) reads back as epoch 0', async () => {
    const alice = await makeMember('alice')
    const [row] = await dispatchSectorKeys([alice.pubJwk])
    expect(readStoredSectorKeyEpoch(row.encryptedGroupKeyBase64)).toBe(0)
  })

  it('a removed member cannot unwrap a freshly rotated key', async () => {
    // Models a departure: owner mints a NEW sector key at the next epoch and
    // wraps it only for the REMAINING members. The departed member, holding
    // only its old wrapped key, has no row for the new key — forward secrecy.
    const owner = await makeMember('owner')
    const staying = await makeMember('staying')
    const departed = await makeMember('departed')

    const oldKey = await generateAesGcm256Key()
    // Departed member's key from before the rotation (epoch 0).
    const departedOldRow = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, departed.pubJwk, oldKey, owner.pubJwk,
    )

    // Rotation: brand-new key at epoch 1, wrapped ONLY for owner + staying.
    const newKey = await generateAesGcm256Key()
    const stayingNewRow = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, staying.pubJwk, newKey, owner.pubJwk, 1,
    )

    // The staying member converges on the new key.
    const stayingRecovered = await unwrapGroupKeyFromStoredPayload(staying.priv, stayingNewRow)
    expect(await sameKey(newKey, stayingRecovered)).toBe(true)
    // It is genuinely a different key from before the rotation.
    expect(await sameKey(oldKey, stayingRecovered)).toBe(false)
    // The departed member, with only its stale row, cannot reach the new key:
    // its old row decrypts to the OLD key, never the new one.
    const departedRecovered = await unwrapGroupKeyFromStoredPayload(departed.priv, departedOldRow)
    expect(await sameKey(newKey, departedRecovered)).toBe(false)
  })
})

/**
 * D2 — owner-binding of the SECTOR group-key wrap. When the SECTOR context
 * build supplies the chat OWNER's pinned ECDH key as the expected creator key,
 * `unwrapGroupKeyFromStoredPayload` MUST fail closed for any wrap not sealed
 * under the owner's identity. The headline case is an active attacker who
 * re-seals an attacker-chosen AES key under `ECDH(attacker_ephemeral, victim)`
 * and substitutes `attacker_ephemeral_pub` for the creator key: the ECDH math
 * alone reproduces the wrap key (the attacker owns the matching private key),
 * so the unseal would SUCCEED — only the binding stops it.
 */
describe('SECTOR owner-binding (D2: authenticated group-key wrap)', () => {
  it('FAILS CLOSED on the substitution attack: attacker AES key sealed under attacker_ephemeral×victim, creator key swapped', async () => {
    const owner = await makeMember('owner')
    const victim = await makeMember('victim')

    // The owner's legitimate wrap of the real sector key for the victim.
    const realKey = await generateAesGcm256Key()
    const honestRow = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, victim.pubJwk, realKey, owner.pubJwk,
    )
    // Bound to the owner → unwraps to the real key.
    const honest = await unwrapGroupKeyFromStoredPayload(victim.priv, honestRow, owner.pubJwk)
    expect(await sameKey(realKey, honest)).toBe(true)

    // ── The attack ──────────────────────────────────────────────────────────
    // The attacker mints its OWN sector key and seals it under
    // ECDH(attacker_ephemeral_priv, victim_pub), embedding attacker_ephemeral_pub
    // as the "creator" key. This is exactly what `wrapGroupKeyForMemberWithCreatorEcdh`
    // produces when handed the attacker's ephemeral keypair as the creator.
    const attackerEph = await makeMember('attacker-ephemeral')
    const attackerKey = await generateAesGcm256Key()
    const forgedRow = await wrapGroupKeyForMemberWithCreatorEcdh(
      attackerEph.priv, victim.pubJwk, attackerKey, attackerEph.pubJwk,
    )

    // WITHOUT the binding the forged row unseals cleanly to the attacker's key
    // (proves the wrap is genuinely unauthenticated on its own — the whole point
    // of D2). The victim would adopt the attacker's key → full group MITM.
    const unbound = await unwrapGroupKeyFromStoredPayload(victim.priv, forgedRow)
    expect(await sameKey(attackerKey, unbound)).toBe(true)

    // WITH the owner binding the same forged row is rejected before any DH.
    await expect(
      unwrapGroupKeyFromStoredPayload(victim.priv, forgedRow, owner.pubJwk),
    ).rejects.toThrow(/SECTOR_CREATOR_KEY_UNTRUSTED/)
  })

  it('rejects an ADMIN-sealed wrap: a key wrapped under a non-owner identity is not adopted', async () => {
    // Mirrors the original D2 server hole: an admin (or the server impersonating
    // one) writes a wrapped-key row sealed under the ADMIN's key. Even if that
    // admin is a legitimate group admin, the victim must not adopt a key the
    // OWNER did not mint.
    const owner = await makeMember('owner')
    const admin = await makeMember('admin')
    const victim = await makeMember('victim')
    const key = await generateAesGcm256Key()

    const adminRow = await wrapGroupKeyForMemberWithCreatorEcdh(
      admin.priv, victim.pubJwk, key, admin.pubJwk,
    )
    await expect(
      unwrapGroupKeyFromStoredPayload(victim.priv, adminRow, owner.pubJwk),
    ).rejects.toThrow(/SECTOR_CREATOR_KEY_UNTRUSTED/)
  })

  it('rejects the legacy ephemeral (unbound) format when an owner binding is required', async () => {
    // No real group ever used the ephemeral dispatch format in production, so in
    // owner-bound mode it can only be an attacker downgrade — refuse it outright
    // rather than fall back to the unauthenticated path.
    const owner = await makeMember('owner')
    const victim = await makeMember('victim')
    const [row] = await dispatchSectorKeys([victim.pubJwk])

    // Unbound mode still accepts it (back-compat for the pure round-trip).
    await expect(
      unwrapGroupKeyFromStoredPayload(victim.priv, row.encryptedGroupKeyBase64),
    ).resolves.toBeTruthy()
    // Owner-bound mode rejects it.
    await expect(
      unwrapGroupKeyFromStoredPayload(victim.priv, row.encryptedGroupKeyBase64, owner.pubJwk),
    ).rejects.toThrow(/SECTOR_UNAUTHENTICATED_WRAP_REJECTED/)
  })

  it('accepts the owner-bound wrap even when the owner key is serialized differently (rotation path)', async () => {
    // At rotation the owner passes `exportEcdhPublicJwkFromPrivateKey(priv)` as
    // the creator key, whose JWK field order / optional fields can differ from
    // the owner row's stored `ecdh_public_key_jwk`. The binding compares only the
    // cryptographically significant fields, so a benign re-serialization must NOT
    // false-reject and lock the member out of the group.
    const owner = await makeMember('owner')
    const victim = await makeMember('victim')
    const key = await generateAesGcm256Key()

    // Wrap stamps `creatorEcdhPublicKeyJwk` from the owner's PRIVATE key export.
    const row = await wrapGroupKeyForMemberWithCreatorEcdh(
      owner.priv, victim.pubJwk, key, undefined /* derive from priv */, 2,
    )
    // The "expected owner key" the context passes is the member-roster JWK. Build
    // a deliberately different-but-equivalent serialization to model JWK drift.
    const ownerRosterJwk = await exportEcdhPublicJwkFromPrivateKey(owner.priv)
    const reordered = JSON.stringify({
      // shuffle key order + add a benign optional field
      ext: true,
      ...JSON.parse(ownerRosterJwk),
    })
    expect(ecdhPublicKeysEqual(reordered, ownerRosterJwk)).toBe(true)

    const recovered = await unwrapGroupKeyFromStoredPayload(victim.priv, row, reordered)
    expect(await sameKey(key, recovered)).toBe(true)
  })
})

describe('ecdhPublicKeysEqual', () => {
  it('treats field-order / optional-field differences as equal but a different point as not', async () => {
    const a = await generateKeyPair({ extractable: true })
    const b = await generateKeyPair({ extractable: true })
    const aJwk = await exportPublicKey(a.publicKey)
    const bJwk = await exportPublicKey(b.publicKey)

    const aParsed = JSON.parse(aJwk)
    const aReordered = JSON.stringify({ key_ops: [], y: aParsed.y, x: aParsed.x, crv: aParsed.crv, kty: aParsed.kty })
    expect(ecdhPublicKeysEqual(aJwk, aReordered)).toBe(true)
    expect(ecdhPublicKeysEqual(aJwk, bJwk)).toBe(false)
    // Garbage never matches a real key.
    expect(ecdhPublicKeysEqual(aJwk, 'not-json')).toBe(false)
  })
})
