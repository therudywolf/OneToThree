import { create } from 'zustand'
import type { DecryptedMessage } from '@/types/chat'

const RAM_WINDOW_SIZE = 50

function sortByCreatedAt(messages: DecryptedMessage[]): DecryptedMessage[] {
  return [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )
}

function trimToRamWindow(messages: DecryptedMessage[]): DecryptedMessage[] {
  if (messages.length <= RAM_WINDOW_SIZE) return messages
  return messages.slice(messages.length - RAM_WINDOW_SIZE)
}

type ChatState = {
  activeChatId: string | null
  messages: DecryptedMessage[]
  unwrappedPrivateKey: CryptoKey | null
  userId: string | null
  replyTo: DecryptedMessage | null
  typingUsers: Record<string, Record<string, { username: string; expiresAt: number }>>
  setActiveChatId: (id: string | null) => void
  setMessages: (messages: DecryptedMessage[]) => void
  appendMessage: (m: DecryptedMessage) => void
  removeMessage: (id: string) => void
  setReplyTo: (m: DecryptedMessage | null) => void
  setUnwrappedPrivateKey: (k: CryptoKey | null) => void
  setUserId: (id: string | null) => void
  setTypingUser: (chatId: string, userId: string, username: string, ttlMs?: number) => void
  clearTypingUser: (chatId: string, userId: string) => void
  clearTypingUserEverywhere: (userId: string) => void
  pruneTypingUsers: (nowMs?: number) => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  activeChatId: null,
  messages: [],
  unwrappedPrivateKey: null,
  userId: null,
  replyTo: null,
  typingUsers: {},
  setActiveChatId: (id) => set({ activeChatId: id, replyTo: null }),
  setMessages: (messages) =>
    set({
      messages: trimToRamWindow(sortByCreatedAt(messages)),
    }),
  appendMessage: (m) =>
    set((s) => {
      if (s.messages.some((x) => x.id === m.id)) {
        return s
      }
      return {
        messages: trimToRamWindow(sortByCreatedAt([...s.messages, m])),
      }
    }),
  removeMessage: (id) =>
    set((s) => ({
      messages: s.messages.filter((m) => m.id !== id),
    })),
  setReplyTo: (m) => set({ replyTo: m }),
  setUnwrappedPrivateKey: (k) => set({ unwrappedPrivateKey: k }),
  setUserId: (id) => set({ userId: id }),
  setTypingUser: (chatId, userId, username, ttlMs = 3000) =>
    set((s) => ({
      typingUsers: {
        ...s.typingUsers,
        [chatId]: {
          ...(s.typingUsers[chatId] ?? {}),
          [userId]: {
            username,
            expiresAt: Date.now() + ttlMs,
          },
        },
      },
    })),
  clearTypingUser: (chatId, userId) =>
    set((s) => {
      const bucket = { ...(s.typingUsers[chatId] ?? {}) }
      delete bucket[userId]
      const typingUsers = { ...s.typingUsers }
      if (Object.keys(bucket).length === 0) delete typingUsers[chatId]
      else typingUsers[chatId] = bucket
      return { typingUsers }
    }),
  clearTypingUserEverywhere: (userId) =>
    set((s) => {
      const typingUsers: ChatState['typingUsers'] = {}
      for (const [chatId, users] of Object.entries(s.typingUsers)) {
        const nextUsers = { ...users }
        delete nextUsers[userId]
        if (Object.keys(nextUsers).length > 0) typingUsers[chatId] = nextUsers
      }
      return { typingUsers }
    }),
  pruneTypingUsers: (nowMs = Date.now()) =>
    set((s) => {
      const typingUsers: ChatState['typingUsers'] = {}
      for (const [chatId, users] of Object.entries(s.typingUsers)) {
        const nextUsers: Record<string, { username: string; expiresAt: number }> = {}
        for (const [uid, state] of Object.entries(users)) {
          if (state.expiresAt > nowMs) nextUsers[uid] = state
        }
        if (Object.keys(nextUsers).length > 0) typingUsers[chatId] = nextUsers
      }
      return { typingUsers }
    }),
  reset: () =>
    set({
      activeChatId: null,
      messages: [],
      unwrappedPrivateKey: null,
      userId: null,
      replyTo: null,
      typingUsers: {},
    }),
}))
