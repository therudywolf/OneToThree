'use client'

import { useCallback, useState } from 'react'
import { createGroupE2EChat } from '@/lib/api/chats'
import { lookupUsers } from '@/lib/api/users'
import { wrapGroupKeyForMemberWithCreatorEcdh } from '@/lib/chat-logic'
import { useChatStore } from '@/store/chatStore'

const CREATE_TIMEOUT_MS = 90_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(label))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(id)
        resolve(v)
      },
      (e) => {
        clearTimeout(id)
        reject(e)
      }
    )
  })
}

/**
 * @param currentUserId — session user id from the tree (ChatApp → Sidebar); do not rely on Zustand alone.
 */
export function useCreateGroup(currentUserId: string) {
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setBusy(false)
    setError(null)
  }, [])

  const createGroup = useCallback(
    async (name: string | null, otherMemberUserIds: string[]) => {
      setError(null)
      setBusy(true)
      try {
        if (!currentUserId?.trim()) {
          throw new Error('NO_SESSION_USER')
        }
        if (!unwrappedPrivateKey) {
          throw new Error('NO_VAULT')
        }

        const others = Array.from(
          new Set(otherMemberUserIds.filter((id) => id !== currentUserId))
        )
        const allIds = Array.from(new Set([currentUserId, ...others]))
        if (allIds.length < 2) {
          throw new Error('NEED_AT_LEAST_ONE_OTHER_MEMBER')
        }

        const rows = await withTimeout(
          lookupUsers(allIds),
          CREATE_TIMEOUT_MS,
          'REQUEST_TIMEOUT'
        )

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

        const chat = await withTimeout(
          createGroupE2EChat({
            name: name?.trim() || null,
            members,
          }),
          CREATE_TIMEOUT_MS,
          'REQUEST_TIMEOUT'
        )
        return chat
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'CREATE_GROUP_FAILED'
        setError(msg)
        throw e
      } finally {
        setBusy(false)
      }
    },
    [currentUserId, unwrappedPrivateKey]
  )

  const clearError = useCallback(() => setError(null), [])

  return { createGroup, busy, error, clearError, reset }
}
