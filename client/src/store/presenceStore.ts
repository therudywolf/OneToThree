import { create } from 'zustand'

/**
 * PRESENCE STORE — presence/typing layer
 * Owns: typingUsers, peerPresence
 */

type PeerStatusMap = Record<string, { online: boolean; last_seen_at: string | null }>
type TypingMap = Record<string, Record<string, { username: string; expiresAt: number }>>

export type PresenceState = {
  typingUsers: TypingMap
  peerPresence: PeerStatusMap

  setTypingUser: (chatId: string, uid: string, uname: string, ttl?: number) => void
  clearTypingUser: (chatId: string, uid: string) => void
  clearTypingUserEverywhere: (uid: string) => void
  pruneTypingUsers: (now?: number) => void
  setPeerPresence: (uid: string, status: { online: boolean; last_seen_at: string | null }) => void
  mergePeerPresenceBatch: (rows: { id: string; online: boolean; last_seen_at: string | null }[]) => void
  reset: () => void
}

export const usePresenceStore = create<PresenceState>((set) => ({
  typingUsers: {},
  peerPresence: {},

  setTypingUser: (chatId, uid, uname, ttl = 3000) =>
    set((s) => ({
      typingUsers: {
        ...s.typingUsers,
        [chatId]: {
          ...(s.typingUsers[chatId] ?? {}),
          [uid]: { username: uname, expiresAt: Date.now() + ttl },
        },
      },
    })),

  clearTypingUser: (chatId, uid) =>
    set((s) => {
      const bucket = { ...(s.typingUsers[chatId] ?? {}) }
      delete bucket[uid]
      const nextTyping = { ...s.typingUsers }
      if (Object.keys(bucket).length === 0) delete nextTyping[chatId]
      else nextTyping[chatId] = bucket
      return { typingUsers: nextTyping }
    }),

  clearTypingUserEverywhere: (uid) =>
    set((s) => {
      const nextTyping: TypingMap = {}
      for (const [chatId, users] of Object.entries(s.typingUsers)) {
        const nextUsers = { ...users }
        delete nextUsers[uid]
        if (Object.keys(nextUsers).length > 0) nextTyping[chatId] = nextUsers
      }
      return { typingUsers: nextTyping }
    }),

  pruneTypingUsers: (now = Date.now()) =>
    set((s) => {
      const nextTyping: TypingMap = {}
      let changed = false
      for (const [chatId, users] of Object.entries(s.typingUsers)) {
        const nextUsers: Record<string, { username: string; expiresAt: number }> = {}
        for (const [uid, state] of Object.entries(users)) {
          if (state.expiresAt > now) nextUsers[uid] = state
          else changed = true
        }
        if (Object.keys(nextUsers).length > 0) nextTyping[chatId] = nextUsers
        else changed = true
      }
      return changed ? { typingUsers: nextTyping } : s
    }),

  setPeerPresence: (uid, status) =>
    set((s) => ({ peerPresence: { ...s.peerPresence, [uid]: status } })),

  mergePeerPresenceBatch: (rows) =>
    set((s) => {
      const nextStatus = { ...s.peerPresence }
      rows.forEach((r) => { nextStatus[r.id] = { online: r.online, last_seen_at: r.last_seen_at } })
      return { peerPresence: nextStatus }
    }),

  reset: () => set({ typingUsers: {}, peerPresence: {} }),
}))
