// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * PROJECT 13 :: SECTOR_KEY_ROTATION
 *
 * When a member departs a SECTOR (group_e2e) chat — kicked or left — the server
 * bumps `chats.key_epoch` and broadcasts `group_key_epoch`. The remaining
 * members must then converge on a BRAND-NEW group key so the departed member can
 * no longer read traffic sent after their departure (forward secrecy).
 *
 * Design (owner decision 2026-05-30, see docs/project/GROUP_KEY_ROTATION_PLAN.md):
 *
 * - **History is NOT preserved.** Messages sent before the rotation were sealed
 *   under the prior key; once members adopt the new key those rows no longer
 *   decrypt. This is the accepted trade-off that keeps rotation migration-free
 *   (no per-epoch message tagging, no client key history).
 *
 * - **The chat OWNER is the single rotator.** Letting every admin rotate would
 *   race two different keys into the group. Concentrating it on the owner makes
 *   the outcome deterministic. Voluntary-leave already promotes a new owner
 *   server-side, so "the owner" is always well-defined after the membership
 *   change settles.
 *
 * - **Epoch-stamped keys, not live-event-only.** `group_key_epoch` is a live WS
 *   event and is NOT replayed, so an owner offline during the kick would never
 *   rotate. Instead each rotated wrapped key carries its epoch (see
 *   `readStoredSectorKeyEpoch`); the owner can therefore detect a stale key on
 *   the NEXT chat open and rotate then. The live event is just an early trigger.
 *
 * - **Server holds no key material.** The owner generates AES-256-GCM locally,
 *   wraps it per remaining member under ECDH, and PUTs each wrapped blob. The
 *   wrapped-key PUT broadcasts `chats_updated` to the affected member, and
 *   `useChatCryptoContext` rebuilds the active SECTOR context on that signal —
 *   so a non-owner picks up the rotated key and decrypts post-rotation traffic
 *   without having to switch chats.
 *
 * - **Partial rotation self-heals.** Delivery is best-effort per member; a PUT
 *   that fails leaves that member on a stale-epoch key. The owner's key-
 *   distribution scan (`useGroupKeyDistribution`) re-delivers the current key to
 *   any member whose stored epoch is behind the owner's, so the group reconverges
 *   on the next chat open or membership event.
 */

import {
  fetchChatDetail,
  uploadMemberWrappedGroupKey,
  type ChatDetailPayload,
} from '@/lib/api/chats'
import {
  wrapGroupKeyForMemberWithCreatorEcdh,
  readStoredSectorKeyEpoch,
} from '@/lib/chat-logic'
import { exportEcdhPublicJwkFromPrivateKey } from '@/lib/crypto'

export type RotationResult =
  | { rotated: true; epoch: number; members: number }
  | { rotated: false; reason: string }

/**
 * Decide whether THIS client should rotate the group key for `detail`, given its
 * user id. Only the owner rotates, and only when the owner's own stored key is
 * behind the chat's current epoch (or absent). Pure + synchronous so it can be
 * unit-tested and called as a cheap guard before the crypto work.
 */
export function shouldRotateGroupKey(
  detail: ChatDetailPayload,
  myUserId: string,
  currentEpoch: number
): boolean {
  if (detail.chat.type !== 'group_e2e') return false
  if (detail.chat.my_role !== 'owner') return false
  const me = detail.members.find((m) => m.user_id === myUserId)
  if (!me) return false
  if (!me.encrypted_group_key) {
    // No cached key. Rotation MINTS a fresh key (it never needs the old one), so
    // a missing key is not a blocker — it is only a reason not to rotate at group
    // creation. Rotate iff the chat has already advanced past creation, i.e. a
    // departure bumped the epoch: an owner promoted mid-group without a key must
    // still mint the post-departure key, or the departed member keeps reading
    // traffic (forward-secrecy bypass). At epoch 0 there is nothing to rotate —
    // creation-time key delivery / the distribution scan handles a missing key.
    return currentEpoch > 0
  }
  // Rotate when our stored key predates the current epoch. A null (unparseable)
  // epoch is treated as stale so a corrupt local blob still forces a refresh.
  const storedEpoch = readStoredSectorKeyEpoch(me.encrypted_group_key)
  return storedEpoch === null || storedEpoch < currentEpoch
}

/**
 * Owner-only: mint a fresh AES-256-GCM sector key and distribute it, stamped
 * with `targetEpoch`, to EVERY current member (including the owner itself — the
 * server permits self-target specifically so the rotator can persist its own
 * key, which it must because the SECTOR context is rebuilt from the server, not
 * cached). Best-effort per member: a member whose ECDH key is missing or whose
 * upload fails is skipped and left to the key-distribution scan (which re-delivers
 * to members missing OR behind the current epoch) to repair, rather than aborting
 * the whole rotation.
 *
 * Caller must have already confirmed `shouldRotateGroupKey`. `myPrivateKey` is
 * the unwrapped vault private key.
 */
export async function rotateGroupKeyForChat(
  chatId: string,
  myUserId: string,
  myPrivateKey: CryptoKey,
  targetEpoch: number
): Promise<RotationResult> {
  const detail = await fetchChatDetail(chatId)
  if (detail.chat.type !== 'group_e2e') {
    return { rotated: false, reason: 'NOT_GROUP' }
  }
  if (detail.chat.my_role !== 'owner') {
    return { rotated: false, reason: 'NOT_OWNER' }
  }

  const myPubJwk = await exportEcdhPublicJwkFromPrivateKey(myPrivateKey)

  const newKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )

  let delivered = 0
  for (const m of detail.members) {
    if (!m.ecdh_public_key_jwk) continue
    try {
      const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
        myPrivateKey,
        m.ecdh_public_key_jwk,
        newKey,
        myPubJwk,
        targetEpoch
      )
      await uploadMemberWrappedGroupKey(chatId, m.user_id, wrapped)
      delivered += 1
    } catch {
      // Best-effort: a transient PUT failure or a member mid-rekey is recovered
      // by the next rotation pass or the key-distribution scan. Do not abort —
      // partial delivery still advances remaining members off the old key.
    }
  }

  if (delivered === 0) {
    return { rotated: false, reason: 'NO_MEMBERS_DELIVERED' }
  }
  return { rotated: true, epoch: targetEpoch, members: delivered }
}
