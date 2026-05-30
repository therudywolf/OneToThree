'use client'

import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import {
  fetchChatDetail,
  uploadMemberWrappedGroupKey,
} from '@/lib/api/chats'
import {
  wrapGroupKeyForMemberWithCreatorEcdh,
  unwrapGroupKeyFromStoredPayload,
  readStoredSectorKeyEpoch,
} from '@/lib/chat-logic'
import {
  shouldRotateGroupKey,
  rotateGroupKeyForChat,
} from '@/lib/group-key-rotation'
import { getFmSocket } from '@/lib/api/socket'
import type { ChatCryptoContext } from '@/lib/chat-crypto'

/**
 * Deliver a group key to a member who has none.
 *
 * Works for ANY chat the current user is admin/owner of — not just the active
 * one. Fetches the chat detail, decrypts our own group key using the vault
 * private key, re-encrypts it for the target member, and uploads it.
 */
async function deliverGroupKeyToMember(
  chatId: string,
  targetUserId: string,
  myPrivKey: CryptoKey,
  myUserId: string
): Promise<void> {
  const detail = await fetchChatDetail(chatId)
  const { my_role } = detail.chat
  if (my_role !== 'owner' && my_role !== 'admin') return

  const me = detail.members.find((m) => m.user_id === myUserId)
  if (!me?.encrypted_group_key) return

  const target = detail.members.find((m) => m.user_id === targetUserId)
  if (!target?.ecdh_public_key_jwk) return
  if (target.encrypted_group_key) return // already delivered

  const groupKey = await unwrapGroupKeyFromStoredPayload(myPrivKey, me.encrypted_group_key)
  // Stamp the delivered key with the epoch of the material we are actually
  // handing over (our own stored key's epoch), so the recovery scan can later
  // tell whether this member is on the current key. Truthful labelling matters:
  // never stamp a key with an epoch newer than the bytes it carries.
  const myEpoch = readStoredSectorKeyEpoch(me.encrypted_group_key) ?? 0
  const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
    myPrivKey,
    target.ecdh_public_key_jwk,
    groupKey,
    undefined,
    myEpoch
  )
  await uploadMemberWrappedGroupKey(chatId, targetUserId, wrapped)
}

/**
 * Owner-only: if our stored sector key is behind the chat's current epoch (a
 * member departed), mint a fresh key and redistribute it to all members. Safe
 * to call on chat open and on the `group_key_epoch` event — `shouldRotateGroupKey`
 * makes it a no-op once our key already matches the epoch, so repeat calls don't
 * churn. Returns true if a rotation was performed.
 */
async function rotateGroupKeyIfStale(
  chatId: string,
  myUserId: string,
  myPrivKey: CryptoKey
): Promise<boolean> {
  const detail = await fetchChatDetail(chatId)
  const epoch = detail.chat.key_epoch ?? 0
  if (!shouldRotateGroupKey(detail, myUserId, epoch)) return false
  const res = await rotateGroupKeyForChat(chatId, myUserId, myPrivKey, epoch)
  return res.rotated
}

/**
 * Three-part hook:
 *
 * 1. On active-chat open: (a) rotate the sector key if a member departed while
 *    we were away (owner only, epoch-driven), then (b) scan for members without
 *    keys and deliver (catches members who joined while admin was offline).
 *
 * 2. On `member_joined` WS event: immediately deliver the group key to the
 *    new member even if the chat is not currently active.
 *
 * 3. On `group_key_epoch` WS event (a member was kicked/left): the owner mints a
 *    fresh sector key and redistributes it, so the departed member can no longer
 *    read traffic sent after their departure.
 */
export function useGroupKeyDistribution(
  cryptoCtx: ChatCryptoContext | null,
  reloadChats: () => void
) {
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const userId = useSessionStore((s) => s.userId)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)
  const busyRef = useRef(false)

  // Part 1: on active-chat open — rotate the sector key if it is stale (a member
  // departed while we were away), otherwise deliver our current key to members
  // who are missing it or are behind the current epoch.
  useEffect(() => {
    if (
      !activeChatId ||
      !userId ||
      !unwrappedPrivateKey ||
      !cryptoCtx ||
      cryptoCtx.mode !== 'SECTOR'
    ) {
      return
    }

    let cancelled = false
    void (async () => {
      if (busyRef.current) return
      busyRef.current = true
      try {
        // 1a. Rotate first if our key is stale (a member departed). A successful
        // rotation already re-wrapped the FRESH key for every member, so skip the
        // delivery scan below — it would otherwise hand out the pre-rotation key
        // still held in `cryptoCtx.groupKey` (the in-memory context is rebuilt
        // only after the rotation's `chats_updated` lands; see useChatCryptoContext).
        const rotated = await rotateGroupKeyIfStale(
          activeChatId,
          userId,
          unwrappedPrivateKey
        )
        if (cancelled) return
        if (rotated) {
          reloadChats()
          return
        }

        // 1b. Deliver our current key to members who are MISSING it, or whose key
        // is BEHIND ours (a rotation whose PUT failed for them left them split off
        // on a stale key — re-wrap the current key so the group reconverges). The
        // delivered key is stamped with our own key's epoch, and we only upgrade
        // members who are strictly behind it — never downgrade.
        const detail = await fetchChatDetail(activeChatId)
        if (cancelled) return
        const r = detail.chat.my_role
        if (r !== 'owner' && r !== 'admin') return
        const myMember = detail.members.find((m) => m.user_id === userId)
        const myEpoch = myMember?.encrypted_group_key
          ? (readStoredSectorKeyEpoch(myMember.encrypted_group_key) ?? 0)
          : 0

        let delivered = false
        for (const m of detail.members) {
          if (cancelled) return
          if (m.user_id === userId) continue
          if (!m.ecdh_public_key_jwk) continue
          const stored = m.encrypted_group_key
            ? readStoredSectorKeyEpoch(m.encrypted_group_key)
            : null
          const needsKey = stored === null || stored < myEpoch
          if (!needsKey) continue
          const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
            unwrappedPrivateKey,
            m.ecdh_public_key_jwk,
            cryptoCtx.groupKey,
            undefined,
            myEpoch
          )
          await uploadMemberWrappedGroupKey(activeChatId, m.user_id, wrapped)
          delivered = true
        }
        if (delivered) reloadChats()
      } catch (e) {
        console.warn('>> [SYS.SECTOR] group-key rotation/delivery scan failed', e)
      } finally {
        busyRef.current = false
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeChatId, userId, unwrappedPrivateKey, cryptoCtx, reloadChats])

  // Part 2 & 3: react to member_joined (deliver key) and group_key_epoch (rotate).
  useEffect(() => {
    if (!userId || !unwrappedPrivateKey) return
    const socket = getFmSocket()
    const off = socket.subscribe((msg) => {
      if (msg.type === 'member_joined') {
        const { chat_id, user_id: newUserId } = msg
        if (newUserId === userId) return // we are the one who joined
        void deliverGroupKeyToMember(chat_id, newUserId, unwrappedPrivateKey, userId)
          .then(() => reloadChats())
          .catch((e) => {
            console.warn('>> [SYS.SECTOR] deliver-group-key-on-join failed', e)
          })
        return
      }
      if (msg.type === 'group_key_epoch') {
        // A member was kicked or left. The owner mints + redistributes a fresh
        // sector key; non-owners no-op here and pick up the new key via the
        // `chats_updated` the wrapped-key upload broadcasts.
        const { chat_id } = msg
        void rotateGroupKeyIfStale(chat_id, userId, unwrappedPrivateKey)
          .then((rotated) => { if (rotated) reloadChats() })
          .catch((e) => {
            console.warn('>> [SYS.SECTOR] group-key rotation on epoch event failed', e)
          })
      }
    })
    return off
  }, [userId, unwrappedPrivateKey, reloadChats])
}
