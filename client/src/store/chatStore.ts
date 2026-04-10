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
  setActiveChatId: (id: string | null) => void
  setMessages: (messages: DecryptedMessage[]) => void
  appendMessage: (m: DecryptedMessage) => void
  removeMessage: (id: string) => void
  setReplyTo: (m: DecryptedMessage | null) => void
  setUnwrappedPrivateKey: (k: CryptoKey | null) => void
  setUserId: (id: string | null) => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  activeChatId: null,
  messages: [],
  unwrappedPrivateKey: null,
  userId: null,
  replyTo: null,
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
  reset: () =>
    set({
      activeChatId: null,
      messages: [],
      unwrappedPrivateKey: null,
      userId: null,
      replyTo: null,
    }),
}))
