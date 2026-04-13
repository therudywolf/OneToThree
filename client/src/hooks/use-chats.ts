'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchChatsList, type ApiChatRow } from '@/lib/api/chats'
import { getFmSocket } from '@/lib/api/socket'

export function useChats(userId: string | null) {
  const [chats, setChats] = useState<ApiChatRow[]>([])
  const [initialLoading, setInitialLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!userId) {
      setChats([])
      setInitialLoading(false)
      return
    }
    try {
      setChats(await fetchChatsList())
    } catch {
      setChats([])
    } finally {
      setInitialLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    return socket.subscribe((m) => {
      if (m.type === 'chats_updated') {
        void reload()
      }
    })
  }, [userId, reload])

  return { chats, reload, initialLoading }
}
