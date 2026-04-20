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

const CHAT_SOUND_KEY = 'p13:chat_sound_enabled'

function loadChatSoundEnabled(): boolean {
  try {
    const v = localStorage.getItem(CHAT_SOUND_KEY)
    return v === null ? true : v === 'true'
  } catch {
    return true
  }
}

type PeerStatusMap = Record<string, { online: boolean; last_seen_at: string | null }>
type TypingMap = Record<string, Record<string, { username: string; expiresAt: number }>>
type ThreadUnreadMap = Record<string, number>
type ChatUnreadState = {
  total: number
  mentions: number
  threads: ThreadUnreadMap
}
type UnreadByChat = Record<string, ChatUnreadState>

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

export type ChatState = {
  // [IDENT_LAYER]
  activeChatId: string | null
  userId: string | null
  selfUsername: string | null
  unwrappedPrivateKey: CryptoKey | null

  // [DATA_LAYER]
  messages: DecryptedMessage[]
  replyTo: DecryptedMessage | null
  /** Message staged for inline edit — composer loads its plaintext into the
   * input box and switches send into "edit" mode. Setting to null cancels. */
  editingMessage: DecryptedMessage | null

  // [PRESENCE_LAYER]
  typingUsers: TypingMap
  peerPresence: PeerStatusMap

  // [SYNC_LAYER]
  readAtOverrides: Record<string, string>
  historyDecryptBusy: boolean
  unreadByChat: UnreadByChat
  unreadTotal: number

  // [SOUND]
  chatSoundEnabled: boolean

  // [ACTIONS]
  setActiveChatId: (id: string | null) => void
  setSelfUsername: (value: string | null) => void
  setMessages: (nodes: DecryptedMessage[]) => void
  appendMessage: (node: DecryptedMessage) => void
  removeMessage: (id: string) => void
  pruneBurnedMessages: (now?: number) => void
  setReplyTo: (node: DecryptedMessage | null) => void
  setEditingMessage: (node: DecryptedMessage | null) => void
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
  markChatRead: (chatId: string) => void
  markThreadRead: (chatId: string, threadId: string) => void
  clearAllUnread: () => void
  trackInboundUnread: (params: {
    chatId: string
    senderId: string
    replyToId?: string | null
    isForegroundVisible: boolean
    isActiveChat: boolean
  }) => void
  setHistoryDecryptBusy: (busy: boolean) => void
  setChatSoundEnabled: (enabled: boolean) => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set, _get) => {
  const setActiveChatId = (id: string | null) =>
    set((s) => {
      if (!id) return { activeChatId: id, replyTo: null, readAtOverrides: {}, historyDecryptBusy: false }
      if (!s.unreadByChat[id]) return { activeChatId: id, replyTo: null, readAtOverrides: {}, historyDecryptBusy: false }
      const nextUnread = { ...s.unreadByChat }
      delete nextUnread[id]
      return {
        activeChatId: id,
        replyTo: null,
        readAtOverrides: {},
        historyDecryptBusy: false,
        unreadByChat: nextUnread,
        unreadTotal: countUnreadTotal(nextUnread),
      }
    })

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
  const setEditingMessage = (node: DecryptedMessage | null) =>
    set({ editingMessage: node })
  const setUnwrappedPrivateKey = (key: CryptoKey | null) => set({ unwrappedPrivateKey: key })
  const setUserId = (id: string | null) => set({ userId: id })
  const setSelfUsername = (value: string | null) => set({ selfUsername: value })

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

  const markChatRead = (chatId: string) =>
    set((s) => {
      if (!s.unreadByChat[chatId]) return s
      const nextUnread = { ...s.unreadByChat }
      delete nextUnread[chatId]
      return { unreadByChat: nextUnread, unreadTotal: countUnreadTotal(nextUnread) }
    })

  const markThreadRead = (chatId: string, threadId: string) =>
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
    })

  const clearAllUnread = () => set({ unreadByChat: {}, unreadTotal: 0 })

  const trackInboundUnread = (params: {
    chatId: string
    senderId: string
    replyToId?: string | null
    isForegroundVisible: boolean
    isActiveChat: boolean
  }) =>
    set((s) => {
      if (!s.userId) return s
      if (params.senderId === s.userId) return s
      if (params.isForegroundVisible && params.isActiveChat) return s

      const chatUnread = s.unreadByChat[params.chatId] ?? emptyUnreadState()
      const nextThreads = { ...chatUnread.threads }
      if (params.replyToId) {
        nextThreads[params.replyToId] = (nextThreads[params.replyToId] ?? 0) + 1
      }

      const mentionByReply = hasMentionByReplyToOwnMessage({
        replyToId: params.replyToId ?? null,
        messages: s.messages,
        userId: s.userId,
      })
      const nextChat: ChatUnreadState = {
        total: chatUnread.total + 1,
        mentions: chatUnread.mentions + (mentionByReply ? 1 : 0),
        threads: nextThreads,
      }

      const nextUnread = { ...s.unreadByChat, [params.chatId]: nextChat }
      return { unreadByChat: nextUnread, unreadTotal: countUnreadTotal(nextUnread) }
    })

  const setHistoryDecryptBusy = (busy: boolean) => set({ historyDecryptBusy: busy })

  const setChatSoundEnabled = (enabled: boolean) => {
    try { localStorage.setItem(CHAT_SOUND_KEY, String(enabled)) } catch { /* ignore */ }
    set({ chatSoundEnabled: enabled })
  }

  const reset = () =>
    set({
      activeChatId: null,
      userId: null,
      selfUsername: null,
      unwrappedPrivateKey: null,
      messages: [],
      replyTo: null,
      editingMessage: null,
      typingUsers: {},
      peerPresence: {},
      readAtOverrides: {},
      historyDecryptBusy: false,
      unreadByChat: {},
      unreadTotal: 0,
    })

  return {
    activeChatId: null,
    userId: null,
    selfUsername: null,
    unwrappedPrivateKey: null,
    messages: [],
    replyTo: null,
    editingMessage: null,
    typingUsers: {},
    peerPresence: {},
    readAtOverrides: {},
    historyDecryptBusy: false,
    unreadByChat: {},
    unreadTotal: 0,
    chatSoundEnabled: loadChatSoundEnabled(),

    setActiveChatId,
    setSelfUsername,
    setMessages,
    appendMessage,
    removeMessage,
    pruneBurnedMessages,
    setReplyTo,
    setEditingMessage,
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
    markChatRead,
    markThreadRead,
    clearAllUnread,
    trackInboundUnread,
    setHistoryDecryptBusy,
    setChatSoundEnabled,
    reset,
  }
})
