'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // Debounce the query that drives the O(n) scan over every decrypted message,
  // so the filter runs ~150ms after typing settles rather than on every
  // keystroke (this also collapses IME composition keystrokes into one scan).
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(query), 150)
    return () => clearTimeout(h)
  }, [query])

  const results: DecryptedMessage[] = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q || q.length < 2) return []
    return messages.filter(
      (m) => m.plaintext && m.plaintext.toLowerCase().includes(q)
    )
  }, [messages, debouncedQuery])

  // Free-text search must NOT go through sanitizeTextInput: that helper blanks
  // the literal words "undefined"/"null" (an ID/capability-input guard), which
  // silently breaks a legitimate message search for those words. `q` is always
  // a string here and the q.length<2 check already handles empties.
  const search = useCallback((q: string) => setQuery(q), [])
  const clear = useCallback(() => {
    setQuery('')
    setDebouncedQuery('')
  }, [])

  return { query, debouncedQuery, results, search, clear }
}
