import { create } from 'zustand'
import type { DecryptedMessage } from '@/types/chat'

type ChatState = {
  activeChatId: string | null
  messages: DecryptedMessage[]
  unwrappedPrivateKey: CryptoKey | null
  userId: string | null
  setActiveChatId: (id: string | null) => void
  setMessages: (messages: DecryptedMessage[]) => void
  appendMessage: (m: DecryptedMessage) => void
  setUnwrappedPrivateKey: (k: CryptoKey | null) => void
  setUserId: (id: string | null) => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  activeChatId: null,
  messages: [],
  unwrappedPrivateKey: null,
  userId: null,
  setActiveChatId: (id) => set({ activeChatId: id }),
  setMessages: (messages) => set({ messages }),
  appendMessage: (m) =>
    set((s) => {
      if (s.messages.some((x) => x.id === m.id)) {
        return s
      }
      return {
        messages: [...s.messages, m].sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        ),
      }
    }),
  setUnwrappedPrivateKey: (k) => set({ unwrappedPrivateKey: k }),
  setUserId: (id) => set({ userId: id }),
  reset: () =>
    set({
      activeChatId: null,
      messages: [],
      unwrappedPrivateKey: null,
      userId: null,
    }),
}))
