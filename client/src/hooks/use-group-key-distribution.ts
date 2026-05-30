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
  const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
    myPrivKey,
    target.ecdh_public_key_jwk,
    groupKey
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

  // Part 1: scan active chat for members without keys.
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
        // 1a. Rotate first if our key is stale (a member departed). If we did
        // rotate, reload so the rest of the scan sees the fresh blobs.
        const rotated = await rotateGroupKeyIfStale(
          activeChatId,
          userId,
          unwrappedPrivateKey
        )
        if (cancelled) return
        if (rotated) reloadChats()

        const detail = await fetchChatDetail(activeChatId)
        if (cancelled) return
        const r = detail.chat.my_role
        if (r !== 'owner' && r !== 'admin') return

        for (const m of detail.members) {
          if (cancelled) return
          if (m.user_id === userId) continue
          if (m.encrypted_group_key) continue
          if (!m.ecdh_public_key_jwk) continue
          const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
            unwrappedPrivateKey,
            m.ecdh_public_key_jwk,
            cryptoCtx.groupKey
          )
          await uploadMemberWrappedGroupKey(activeChatId, m.user_id, wrapped)
        }
        reloadChats()
      } catch {
        /* best-effort */
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
          .catch(() => { /* best-effort */ })
        return
      }
      if (msg.type === 'group_key_epoch') {
        // A member was kicked or left. The owner mints + redistributes a fresh
        // sector key; non-owners no-op here and pick up the new key via the
        // `chats_updated` the wrapped-key upload broadcasts.
        const { chat_id } = msg
        void rotateGroupKeyIfStale(chat_id, userId, unwrappedPrivateKey)
          .then((rotated) => { if (rotated) reloadChats() })
          .catch(() => { /* best-effort */ })
      }
    })
    return off
  }, [userId, unwrappedPrivateKey, reloadChats])
}
