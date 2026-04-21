'use client'

import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import {
  fetchChatDetail,
  uploadMemberWrappedGroupKey,
} from '@/lib/api/chats'
import { wrapGroupKeyForMemberWithCreatorEcdh } from '@/lib/chat-logic'
import type { ChatCryptoContext } from '@/lib/chat-crypto'

/**
 * When an owner/admin has a working group crypto context, upload wrapped keys
 * for members who joined without one (invite / handshake gap).
 */
export function useGroupKeyDistribution(
  cryptoCtx: ChatCryptoContext | null,
  reloadChats: () => void
) {
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const userId = useSessionStore((s) => s.userId)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)
  const busyRef = useRef(false)

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
}
