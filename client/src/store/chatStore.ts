import { create } from 'zustand'
import { deleteCachedMessage } from '@/lib/message-cache'
import type { DecryptedMessage } from '@/types/chat'

/**
 * PROJECT 13 :: CHAT_PULSE_CORE
 * Level: Session Layer (Volatile RAM)
 * Vibe: Clinical Steel / Zero-Trust Trace
 */

const RAM_CACHE_LIMIT = 50 // Лимит узлов в активной памяти

/** Стерильная сортировка по временной метке */
const sortNodes = (nodes: DecryptedMessage[]): DecryptedMessage[] => {
  return [...nodes].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )
}

/** Изоляция сегмента памяти (STM - Short Term Memory) */
const enforceMemoryLimit = (nodes: DecryptedMessage[]): DecryptedMessage[] => {
  if (nodes.length <= RAM_CACHE_LIMIT) return nodes
  return nodes.slice(nodes.length - RAM_CACHE_LIMIT)
}

type PeerStatusMap = Record<string, { online: boolean; last_seen_at: string | null }>
type TypingMap = Record<string, Record<string, { username: string; expiresAt: number }>>

export type ChatState = {
  // [IDENT_LAYER]
  activeChatId: string | null
  userId: string | null
  unwrappedPrivateKey: CryptoKey | null

  // [DATA_LAYER]
  messages: DecryptedMessage[]
  replyTo: DecryptedMessage | null

  // [PRESENCE_LAYER]
  typingUsers: TypingMap
  peerPresence: PeerStatusMap

  // [SYNC_LAYER]
  readAtOverrides: Record<string, string>
  historyDecryptBusy: boolean

  // [ACTIONS]
  setActiveChatId: (id: string | null) => void
  setMessages: (nodes: DecryptedMessage[]) => void
  appendMessage: (node: DecryptedMessage) => void
  removeMessage: (id: string) => void
  pruneBurnedMessages: (now?: number) => void
  setReplyTo: (node: DecryptedMessage | null) => void
  setUnwrappedPrivateKey: (key: CryptoKey | null) => void
  setUserId: (id: string | null) => void
  setTypingUser: (chatId: string, uid: string, uname: string, ttl?: number) => void
  clearTypingUser: (chatId: string, uid: string) => void
  clearTypingUserEverywhere: (uid: string) => void
  pruneTypingUsers: (now?: number) => void
  setPeerPresence: (uid: string, status: { online: boolean; last_seen_at: string | null }) => void
  mergePeerPresenceBatch: (rows: { id: string; online: boolean; last_seen_at: string | null }[]) => void
  updateMessageReadAt: (nodeId: string, timestamp: string) => void
  updateMessageReactions: (nodeId: string, reactions: Record<string, string[]>) => void
  setHistoryDecryptBusy: (busy: boolean) => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set, get) => {
  const setActiveChatId = (id: string | null) =>
    set({ activeChatId: id, replyTo: null, readAtOverrides: {}, historyDecryptBusy: false })

  const setMessages = (nodes: DecryptedMessage[]) =>
    set({ messages: enforceMemoryLimit(sortNodes(nodes)) })

  const appendMessage = (node: DecryptedMessage) =>
    set((s) => {
      if (s.messages.some((x) => x.id === node.id)) return s
      return { messages: enforceMemoryLimit(sortNodes([...s.messages, node])) }
    })

  const removeMessage = (id: string) =>
    set((s) => ({ messages: s.messages.filter((n) => n.id !== id) }))

  const pruneBurnedMessages = (now = Date.now()) =>
    set((s) => {
      const expired = s.messages.filter((n) => {
        if (!n.burn_at) return false
        const t = new Date(n.burn_at).getTime()
        return Number.isFinite(t) && now > t
      })
      expired.forEach((n) => void deleteCachedMessage(n.id))
      if (expired.length === 0) return s
      const idsToDrop = new Set(expired.map((n) => n.id))
      return { messages: s.messages.filter((n) => !idsToDrop.has(n.id)) }
    })

  const setReplyTo = (node: DecryptedMessage | null) => set({ replyTo: node })
  const setUnwrappedPrivateKey = (key: CryptoKey | null) => set({ unwrappedPrivateKey: key })
  const setUserId = (id: string | null) => set({ userId: id })

  const setTypingUser = (chatId: string, uid: string, uname: string, ttl = 3000) =>
    set((s) => ({
      typingUsers: {
        ...s.typingUsers,
        [chatId]: {
          ...(s.typingUsers[chatId] ?? {}),
          [uid]: { username: uname, expiresAt: Date.now() + ttl },
        },
      },
    }))

  const clearTypingUser = (chatId: string, uid: string) =>
    set((s) => {
      const bucket = { ...(s.typingUsers[chatId] ?? {}) }
      delete bucket[uid]
      const nextTyping = { ...s.typingUsers }
      if (Object.keys(bucket).length === 0) delete nextTyping[chatId]
      else nextTyping[chatId] = bucket
      return { typingUsers: nextTyping }
    })

  const clearTypingUserEverywhere = (uid: string) =>
    set((s) => {
      const nextTyping: TypingMap = {}
      for (const [chatId, users] of Object.entries(s.typingUsers)) {
        const nextUsers = { ...users }
        delete nextUsers[uid]
        if (Object.keys(nextUsers).length > 0) nextTyping[chatId] = nextUsers
      }
      return { typingUsers: nextTyping }
    })

  const pruneTypingUsers = (now = Date.now()) =>
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
    })

  const setPeerPresence = (uid: string, status: { online: boolean; last_seen_at: string | null }) =>
    set((s) => ({ peerPresence: { ...s.peerPresence, [uid]: status } }))

  const mergePeerPresenceBatch = (rows: { id: string; online: boolean; last_seen_at: string | null }[]) =>
    set((s) => {
      const nextStatus = { ...s.peerPresence }
      rows.forEach((r) => { nextStatus[r.id] = { online: r.online, last_seen_at: r.last_seen_at } })
      return { peerPresence: nextStatus }
    })

  const updateMessageReadAt = (nodeId: string, timestamp: string) =>
    set((s) => ({
      readAtOverrides: { ...s.readAtOverrides, [nodeId]: timestamp },
      messages: s.messages.map((n) => n.id === nodeId ? { ...n, read_at: timestamp } : n),
    }))

  const updateMessageReactions = (nodeId: string, reactions: Record<string, string[]>) =>
    set((s) => ({
      messages: s.messages.map((n) => n.id === nodeId ? { ...n, reactions } : n),
    }))

  const setHistoryDecryptBusy = (busy: boolean) => set({ historyDecryptBusy: busy })

  const reset = () =>
    set({
      activeChatId: null,
      userId: null,
      unwrappedPrivateKey: null,
      messages: [],
      replyTo: null,
      typingUsers: {},
      peerPresence: {},
      readAtOverrides: {},
      historyDecryptBusy: false,
    })

  return {
    activeChatId: null,
    userId: null,
    unwrappedPrivateKey: null,
    messages: [],
    replyTo: null,
    typingUsers: {},
    peerPresence: {},
    readAtOverrides: {},
    historyDecryptBusy: false,

    setActiveChatId,
    setMessages,
    appendMessage,
    removeMessage,
    pruneBurnedMessages,
    setReplyTo,
    setUnwrappedPrivateKey,
    setUserId,
    setTypingUser,
    clearTypingUser,
    clearTypingUserEverywhere,
    pruneTypingUsers,
    setPeerPresence,
    mergePeerPresenceBatch,
    updateMessageReadAt,
    updateMessageReactions,
    setHistoryDecryptBusy,
    reset,
  }
})
