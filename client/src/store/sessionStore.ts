import { create } from 'zustand'
import { useUnreadStore } from './unreadStore'

/**
 * SESSION STORE — identity layer
 * Owns: activeChatId, userId, selfUsername, unwrappedPrivateKey
 *
 * setActiveChatId also clears unread + history state for the newly opened
 * chat (mirrors the original chatStore behaviour).
 */

export type SessionState = {
  activeChatId: string | null
  userId: string | null
  selfUsername: string | null
  unwrappedPrivateKey: CryptoKey | null

  setActiveChatId: (id: string | null) => void
  setSelfUsername: (value: string | null) => void
  setUnwrappedPrivateKey: (key: CryptoKey | null) => void
  setUserId: (id: string | null) => void
  reset: () => void
}

export const useSessionStore = create<SessionState>((set) => ({
  activeChatId: null,
  userId: null,
  selfUsername: null,
  unwrappedPrivateKey: null,

  setActiveChatId: (id) => {
    set({ activeChatId: id })
    useUnreadStore.getState().clearReadAtOverrides()
    useUnreadStore.setState({ historyDecryptBusy: false })
    if (id) {
      useUnreadStore.getState().markChatRead(id)
    }
  },

  setSelfUsername: (value) => set({ selfUsername: value }),
  setUnwrappedPrivateKey: (key) => set({ unwrappedPrivateKey: key }),
  setUserId: (id) => set({ userId: id }),

  reset: () =>
    set({
      activeChatId: null,
      userId: null,
      selfUsername: null,
      unwrappedPrivateKey: null,
    }),
}))
