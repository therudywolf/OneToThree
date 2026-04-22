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
 * Two-part hook:
 *
 * 1. On active-chat open: scan for members without group keys and deliver
 *    (catches members who joined while admin was offline).
 *
 * 2. On `member_joined` WS event: immediately deliver the group key to the
 *    new member even if the chat is not currently active.
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

  // Part 2: react to member_joined WS event — deliver key immediately.
  useEffect(() => {
    if (!userId || !unwrappedPrivateKey) return
    const socket = getFmSocket()
    const off = socket.subscribe((msg) => {
      if (msg.type !== 'member_joined') return
      const { chat_id, user_id: newUserId } = msg as {
        type: 'member_joined'
        chat_id: string
        user_id: string
      }
      if (newUserId === userId) return // we are the one who joined
      void deliverGroupKeyToMember(chat_id, newUserId, unwrappedPrivateKey, userId)
        .then(() => reloadChats())
        .catch(() => { /* best-effort */ })
    })
    return off
  }, [userId, unwrappedPrivateKey, reloadChats])
}
