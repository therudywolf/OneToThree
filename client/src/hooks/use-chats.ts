'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchChatsList, type ApiChatRow } from '@/lib/api/chats'
import { getFmSocket } from '@/lib/api/socket'
import { setMutedChatsSnapshot } from '@/lib/muted-chats'
import { useUnreadStore } from '@/store/unreadStore'
import { useSessionStore } from '@/store/sessionStore'

// Coalesce bursty `chats_updated` events into a single refetch. The server can
// emit this for every membership/message-touch in a busy group; without a
// debounce the sidebar re-fetches a full list once per frame and decrypts it.
const CHATS_RELOAD_DEBOUNCE_MS = 350

/**
 * MODULE-level, not per-hook: `useChats` is mounted twice concurrently (the
 * sidebar and ChatApp), each with its own debounce and no ordering guard, and
 * both fetch the same global resource. A per-instance counter would still let
 * the other instance's slower, older snapshot land last.
 *
 * `seedUnreadFromApi` prunes any chat missing from the list it is handed, and
 * the server reports `unread_count = 0` for group chats by design (group unread
 * is tracked client-side only) — so one stale response that predates a freshly
 * joined group silently deleted that group's badge with nothing able to restore
 * it. Only the newest completed response is allowed to prune.
 */
let chatListGeneration = 0
let chatListApplied = 0

export function useChats(userId: string | null) {
  const [chats, setChats] = useState<ApiChatRow[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const seedUnreadFromApi = useUnreadStore((s) => s.seedUnreadFromApi)

  const reload = useCallback(async () => {
    if (!userId) {
      setChats([])
      setMutedChatsSnapshot([])
      setInitialLoading(false)
      return
    }
    const generation = ++chatListGeneration
    try {
      const rows = await fetchChatsList()
      setChats(rows)
      setMutedChatsSnapshot(rows)
      // Is this the newest response to have come back? Only then may it be
      // treated as the authoritative membership snapshot.
      const authoritative = generation > chatListApplied
      if (authoritative) chatListApplied = generation
      // Seed unread counts from server-reported delivery counts so badges are
      // accurate on startup even when messages arrived while the app was closed.
      // Read the LIVE active chat (not the closure) so a reload that started
      // before a chat switch — resolving after — doesn't re-badge the chat the
      // user just opened with stale unread.
      seedUnreadFromApi(rows, useSessionStore.getState().activeChatId, authoritative)
    } catch {
      // Transient failure (network blip / brief 5xx): keep the existing sidebar
      // and muted snapshot. Blanking them would drop every chat and un-mute
      // muted chats until the next successful load. A real logout clears state
      // via the !userId branch above.
    } finally {
      setInitialLoading(false)
    }
    // NOTE: activeChatId is intentionally NOT a dependency — it's read live via
    // useSessionStore.getState() above, so including it would rebuild `reload`
    // (and refire the mount + socket effects) on every chat switch, causing a
    // full chat-list refetch + re-decrypt and a WS listener churn per navigation
    // (#43). Only userId / a chats_updated event should trigger a reload.
  }, [userId, seedUnreadFromApi])

  useEffect(() => {
    void reload()
  }, [reload])

  const debouncedReloadRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!userId) return
    const socket = getFmSocket()
    const off = socket.subscribe((m) => {
      if (m.type === 'group_key_epoch') {
        const { chat_id, key_epoch } = m
        setChats((prev) =>
          prev.map((c) => (c.id === chat_id ? { ...c, key_epoch } : c))
        )
        return
      }
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
