import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DecryptedMessage } from '@/types/chat'
import type { ApiChatRow } from '@/lib/api/chats'
import { createSafeJSONStorage } from '@/lib/safe-zustand-storage'

/**
 * UNREAD STORE — sync/unread layer
 * Owns: unreadByChat, unreadTotal, readAtOverrides, historyDecryptBusy
 */

type ThreadUnreadMap = Record<string, number>
type ChatUnreadState = {
  total: number
  mentions: number
  threads: ThreadUnreadMap
}
export type UnreadByChat = Record<string, ChatUnreadState>

function emptyUnreadState(): ChatUnreadState {
  return { total: 0, mentions: 0, threads: {} }
}

function countUnreadTotal(unreadByChat: UnreadByChat): number {
  return Object.values(unreadByChat).reduce((acc, x) => acc + (x.total || 0), 0)
}

function hasMentionByReplyToOwnMessage(params: {
  replyToId: string | null
  messages: DecryptedMessage[]
  userId: string | null
}): boolean {
  if (!params.replyToId || !params.userId) return false
  const replied = params.messages.find((m) => m.id === params.replyToId)
  return Boolean(replied && replied.sender_id === params.userId)
}

export type UnreadState = {
  unreadByChat: UnreadByChat
  unreadTotal: number
  readAtOverrides: Record<string, string>
  historyDecryptBusy: boolean

  markChatRead: (chatId: string) => void
  markThreadRead: (chatId: string, threadId: string) => void
  clearAllUnread: () => void
  trackInboundUnread: (params: {
    chatId: string
    senderId: string
    replyToId?: string | null
    isForegroundVisible: boolean
    isActiveChat: boolean
    userId: string | null
    messages: DecryptedMessage[]
  }) => void
  setHistoryDecryptBusy: (busy: boolean) => void
  updateReadAtOverride: (nodeId: string, timestamp: string) => void
  clearReadAtOverrides: () => void
  /** Seed unread counts from server-reported delivery counts at startup. */
  seedUnreadFromApi: (chats: ApiChatRow[], activeChatId: string | null) => void
  reset: () => void
}

export const useUnreadStore = create<UnreadState>()(
  persist(
    (set) => ({
      unreadByChat: {},
      unreadTotal: 0,
      readAtOverrides: {},
      historyDecryptBusy: false,

      markChatRead: (chatId) =>
        set((s) => {
          if (!s.unreadByChat[chatId]) return s
          const nextUnread = { ...s.unreadByChat }
          delete nextUnread[chatId]
          return { unreadByChat: nextUnread, unreadTotal: countUnreadTotal(nextUnread) }
        }),

      markThreadRead: (chatId, threadId) =>
        set((s) => {
          const chatUnread = s.unreadByChat[chatId]
          if (!chatUnread) return s
          const dec = chatUnread.threads[threadId] ?? 0
          if (dec <= 0) return s
          const nextThreads = { ...chatUnread.threads }
          delete nextThreads[threadId]
          const nextChat = {
            ...chatUnread,
            total: Math.max(0, chatUnread.total - dec),
            threads: nextThreads,
          }
          const nextUnread = { ...s.unreadByChat, [chatId]: nextChat }
          if (nextChat.total <= 0) delete nextUnread[chatId]
          return { unreadByChat: nextUnread, unreadTotal: countUnreadTotal(nextUnread) }
        }),

      clearAllUnread: () => set({ unreadByChat: {}, unreadTotal: 0 }),

      trackInboundUnread: (params) =>
        set((s) => {
          if (!params.userId) return s
          if (params.senderId === params.userId) return s
          if (params.isForegroundVisible && params.isActiveChat) return s

          const chatUnread = s.unreadByChat[params.chatId] ?? emptyUnreadState()
          const nextThreads = { ...chatUnread.threads }
          if (params.replyToId) {
            nextThreads[params.replyToId] = (nextThreads[params.replyToId] ?? 0) + 1
          }

          const mentionByReply = hasMentionByReplyToOwnMessage({
            replyToId: params.replyToId ?? null,
            messages: params.messages,
            userId: params.userId,
          })
          const nextChat: ChatUnreadState = {
            total: chatUnread.total + 1,
            mentions: chatUnread.mentions + (mentionByReply ? 1 : 0),
            threads: nextThreads,
          }

          const nextUnread = { ...s.unreadByChat, [params.chatId]: nextChat }
          return { unreadByChat: nextUnread, unreadTotal: countUnreadTotal(nextUnread) }
        }),

      setHistoryDecryptBusy: (busy) => set({ historyDecryptBusy: busy }),

      seedUnreadFromApi: (chats, activeChatId) =>
        set((s) => {
          const nextUnread = { ...s.unreadByChat }
          let changed = false
          for (const chat of chats) {
            const serverCount = chat.unread_count ?? 0
            if (serverCount <= 0) continue
            // Don't seed the currently-open chat (user is looking at it).
            if (chat.id === activeChatId) continue
            const existing = nextUnread[chat.id]
            // Only override if server count is higher than what we already track.
            if (!existing || existing.total < serverCount) {
              nextUnread[chat.id] = {
                total: serverCount,
                mentions: existing?.mentions ?? 0,
                threads: existing?.threads ?? {},
              }
              changed = true
            }
          }
          if (!changed) return s
          return { unreadByChat: nextUnread, unreadTotal: countUnreadTotal(nextUnread) }
        }),

      updateReadAtOverride: (nodeId, timestamp) =>
        set((s) => ({ readAtOverrides: { ...s.readAtOverrides, [nodeId]: timestamp } })),

      clearReadAtOverrides: () => set({ readAtOverrides: {} }),

      reset: () =>
        set({
          unreadByChat: {},
          unreadTotal: 0,
          readAtOverrides: {},
          historyDecryptBusy: false,
        }),
    }),
    {
      name: 'p13-unread-store',
      version: 1,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        unreadByChat: state.unreadByChat,
        unreadTotal: state.unreadTotal,
        readAtOverrides: state.readAtOverrides,
      }),
    }
  )
)
