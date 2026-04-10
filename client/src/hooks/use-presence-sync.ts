'use client'

import { useEffect, useMemo } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { fetchUserPresence } from '@/lib/api/users'
import { useChatStore } from '@/store/chatStore'
import type { ApiChatRow } from '@/lib/api/chats'

const PING_MS = 45_000

/** Initial fetch + WS `online_status_change` + lightweight `presence_ping`. */
export function usePresenceSync(userId: string, chats: ApiChatRow[]) {
  const mergePeerPresenceBatch = useChatStore((s) => s.mergePeerPresenceBatch)
  const setPeerPresence = useChatStore((s) => s.setPeerPresence)

  const directPeerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of chats) {
      if (c.is_group) continue
      const peer = c.member_ids.find((id) => id !== userId)
      if (peer) ids.add(peer)
    }
    return [...ids]
  }, [chats, userId])

  useEffect(() => {
    if (directPeerIds.length === 0) return
    let cancelled = false
    void fetchUserPresence(directPeerIds)
      .then((rows) => {
        if (!cancelled) mergePeerPresenceBatch(rows)
      })
      .catch(() => {
        /* offline / auth */
      })
    return () => {
      cancelled = true
    }
  }, [directPeerIds, mergePeerPresenceBatch])

  useEffect(() => {
    const socket = getFmSocket()
    return socket.subscribe((m) => {
      if (m.type !== 'online_status_change') return
      setPeerPresence(m.user_id, {
        online: m.online,
        last_seen_at: m.last_seen_at,
      })
    })
  }, [setPeerPresence])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!getFmSocket().connected) return
      getFmSocket().send({ type: 'presence_ping' })
    }, PING_MS)
    return () => window.clearInterval(id)
  }, [])
}
