'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchChatsList, type ApiChatRow } from '@/lib/api/chats'
import { getFmSocket } from '@/lib/api/socket'
import { setMutedChatsSnapshot } from '@/lib/muted-chats'

// Coalesce bursty `chats_updated` events into a single refetch. The server can
// emit this for every membership/message-touch in a busy group; without a
// debounce the sidebar re-fetches a full list once per frame and decrypts it.
const CHATS_RELOAD_DEBOUNCE_MS = 350

export function useChats(userId: string | null) {
  const [chats, setChats] = useState<ApiChatRow[]>([])
  const [initialLoading, setInitialLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!userId) {
      setChats([])
      setMutedChatsSnapshot([])
      setInitialLoading(false)
      return
    }
    try {
      const rows = await fetchChatsList()
      setChats(rows)
      // Mirror mute state to the non-reactive cache used by the realtime
      // notification path so it doesn't have to re-subscribe on every list
      // update.
      setMutedChatsSnapshot(rows)
    } catch {
      setChats([])
      setMutedChatsSnapshot([])
    } finally {
      setInitialLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void reload()
  }, [reload])

  const debouncedReloadRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    const off = socket.subscribe((m) => {
      if (m.type === 'chats_updated') {
        if (debouncedReloadRef.current) clearTimeout(debouncedReloadRef.current)
        debouncedReloadRef.current = setTimeout(() => {
          debouncedReloadRef.current = null
          void reload()
        }, CHATS_RELOAD_DEBOUNCE_MS)
      }
    })
    return () => {
      off()
      if (debouncedReloadRef.current) {
        clearTimeout(debouncedReloadRef.current)
        debouncedReloadRef.current = null
      }
    }
  }, [userId, reload])

  const patchChat = useCallback((chatId: string, patch: Partial<ApiChatRow>) => {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, ...patch } : c))
    )
  }, [])

  return { chats, reload, initialLoading, patchChat }
}
