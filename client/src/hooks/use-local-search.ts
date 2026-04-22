'use client'

import { useCallback, useMemo, useState } from 'react'
import { useChatStore } from '@/store/chatStore'
import type { DecryptedMessage } from '@/types/chat'

/**
 * Client-side search over decrypted messages in the chatStore.
 * No plaintext ever leaves the browser — search runs against
 * the already-decrypted message array in memory.
 */
export function useLocalSearch() {
  const messages = useChatStore((s) => s.messages)
  const [query, setQuery] = useState('')

  const results: DecryptedMessage[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || q.length < 2) return []
    return messages.filter(
      (m) => m.plaintext && m.plaintext.toLowerCase().includes(q)
    )
  }, [messages, query])

  const search = useCallback((q: string) => setQuery(q), [])
  const clear = useCallback(() => setQuery(''), [])

  return { query, results, search, clear }
}
