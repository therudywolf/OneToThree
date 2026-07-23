'use client'

import { useCallback, useState } from 'react'
import { createKeyedGroupChat } from '@/lib/create-group-chat'
import { useSessionStore } from '@/store/sessionStore'

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
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)
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

        // Core keygen + wrap + POST lives in createKeyedGroupChat (shared with
        // the 1:1→group call promotion, issue #4).
        const chat = await withTimeout(
          createKeyedGroupChat(
            currentUserId,
            unwrappedPrivateKey,
            name,
            otherMemberUserIds
          ),
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
