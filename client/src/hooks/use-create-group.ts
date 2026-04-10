'use client'

import { useCallback, useState } from 'react'
import { createGroupE2EChat } from '@/lib/api/chats'
import { lookupUsers } from '@/lib/api/users'
import { wrapGroupKeyForMemberWithCreatorEcdh } from '@/lib/chat-logic'
import { useChatStore } from '@/store/chatStore'

export function useCreateGroup() {
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createGroup = useCallback(
    async (name: string | null, otherMemberUserIds: string[]) => {
      if (!userId || !unwrappedPrivateKey) {
        throw new Error('NO_VAULT')
      }
      const others = Array.from(
        new Set(otherMemberUserIds.filter((id) => id !== userId))
      )
      const allIds = Array.from(new Set([userId, ...others]))
      if (allIds.length < 2) {
        throw new Error('NEED_AT_LEAST_ONE_OTHER_MEMBER')
      }

      setBusy(true)
      setError(null)
      try {
        const rows = await lookupUsers(allIds)
        for (const r of rows) {
          if (!r.ecdh_public_key_jwk) {
            throw new Error(`MISSING_ECDH:${r.username}`)
          }
        }

        const groupKey = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        )

        const members = await Promise.all(
          rows.map(async (r) => ({
            userId: r.id,
            encryptedGroupKey: await wrapGroupKeyForMemberWithCreatorEcdh(
              unwrappedPrivateKey,
              r.ecdh_public_key_jwk!,
              groupKey
            ),
          }))
        )

        const chat = await createGroupE2EChat({
          name: name?.trim() || null,
          members,
        })
        return chat
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'CREATE_GROUP_FAILED'
        setError(msg)
        throw e
      } finally {
        setBusy(false)
      }
    },
    [userId, unwrappedPrivateKey]
  )

  const clearError = useCallback(() => setError(null), [])

  return { createGroup, busy, error, clearError }
}
