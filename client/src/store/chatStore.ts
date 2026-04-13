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
  vaultKey: CryptoKey | null

  // [DATA_LAYER]
  nodes: DecryptedMessage[]
  replyFocus: DecryptedMessage | null

  // [PRESENCE_LAYER]
  inputPulse: TypingMap
  peerStatus: PeerStatusMap

  // [SYNC_LAYER]
  readOverrides: Record<string, string>
  isDecrypting: boolean

  // [ACTIONS]
  setActiveChat: (id: string | null) => void
  setNodes: (nodes: DecryptedMessage[]) => void
  pushNode: (node: DecryptedMessage) => void
  evictNode: (id: string) => void
  pruneExpiredNodes: (now?: number) => void
  setReplyFocus: (node: DecryptedMessage | null) => void
  setVaultKey: (key: CryptoKey | null) => void
  setUserId: (id: string | null) => void
  registerInputPulse: (chatId: string, uid: string, uname: string, ttl?: number) => void
  clearInputPulse: (chatId: string, uid: string) => void
  purgeGlobalInputPulse: (uid: string) => void
  gcInputPulse: (now?: number) => void
  updatePeerStatus: (uid: string, status: { online: boolean; last_seen_at: string | null }) => void
  batchUpdateStatus: (rows: { id: string; online: boolean; last_seen_at: string | null }[]) => void
  markNodeRead: (nodeId: string, timestamp: string) => void
  setDecryptStatus: (busy: boolean) => void
  resetProtocol: () => void

  // --- CONSUMER_ALIASES ---
  setActiveChatId: (id: string | null) => void
  unwrappedPrivateKey: CryptoKey | null
  messages: DecryptedMessage[]
  readAtOverrides: Record<string, string>
  removeMessage: (id: string) => void
  setReplyTo: (node: DecryptedMessage | null) => void
  replyTo: DecryptedMessage | null
  peerPresence: PeerStatusMap
  typingUsers: TypingMap
  historyDecryptBusy: boolean
  pruneBurnedMessages: (now?: number) => void
  setUnwrappedPrivateKey: (key: CryptoKey | null) => void
  updateMessageReadAt: (nodeId: string, timestamp: string) => void
  setPeerPresence: (uid: string, status: { online: boolean; last_seen_at: string | null }) => void
  mergePeerPresenceBatch: (rows: { id: string; online: boolean; last_seen_at: string | null }[]) => void
  appendMessage: (node: DecryptedMessage) => void
  setTypingUser: (chatId: string, uid: string, uname: string, ttl?: number) => void
  clearTypingUser: (chatId: string, uid: string) => void
  clearTypingUserEverywhere: (uid: string) => void
  pruneTypingUsers: (now?: number) => void
  setMessages: (nodes: DecryptedMessage[]) => void
  setHistoryDecryptBusy: (busy: boolean) => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set, get) => {
  const setActiveChat = (id: string | null) =>
    set({ activeChatId: id, replyFocus: null, readOverrides: {}, isDecrypting: false })

  const setNodes = (nodes: DecryptedMessage[]) =>
    set({ nodes: enforceMemoryLimit(sortNodes(nodes)) })

  const pushNode = (node: DecryptedMessage) =>
    set((s) => {
      if (s.nodes.some((x) => x.id === node.id)) return s
      return { nodes: enforceMemoryLimit(sortNodes([...s.nodes, node])) }
    })

  const evictNode = (id: string) =>
    set((s) => ({ nodes: s.nodes.filter((n) => n.id !== id) }))

  const pruneExpiredNodes = (now = Date.now()) =>
    set((s) => {
      const expired = s.nodes.filter((n) => {
        if (!n.burn_at) return false
        const t = new Date(n.burn_at).getTime()
        return Number.isFinite(t) && now > t
      })
      expired.forEach((n) => void deleteCachedMessage(n.id))
      if (expired.length === 0) return s
      const idsToDrop = new Set(expired.map((n) => n.id))
      return { nodes: s.nodes.filter((n) => !idsToDrop.has(n.id)) }
    })

  const setReplyFocus = (node: DecryptedMessage | null) => set({ replyFocus: node })
  const setVaultKey = (key: CryptoKey | null) => set({ vaultKey: key })
  const setUserId = (id: string | null) => set({ userId: id })

  const registerInputPulse = (chatId: string, uid: string, uname: string, ttl = 3000) =>
    set((s) => ({
      inputPulse: {
        ...s.inputPulse,
        [chatId]: {
          ...(s.inputPulse[chatId] ?? {}),
          [uid]: { username: uname, expiresAt: Date.now() + ttl },
        },
      },
    }))

  const clearInputPulse = (chatId: string, uid: string) =>
    set((s) => {
      const bucket = { ...(s.inputPulse[chatId] ?? {}) }
      delete bucket[uid]
      const nextPulse = { ...s.inputPulse }
      if (Object.keys(bucket).length === 0) delete nextPulse[chatId]
      else nextPulse[chatId] = bucket
      return { inputPulse: nextPulse }
    })

  const purgeGlobalInputPulse = (uid: string) =>
    set((s) => {
      const nextPulse: TypingMap = {}
      for (const [chatId, users] of Object.entries(s.inputPulse)) {
        const nextUsers = { ...users }
        delete nextUsers[uid]
        if (Object.keys(nextUsers).length > 0) nextPulse[chatId] = nextUsers
      }
      return { inputPulse: nextPulse }
    })

  const gcInputPulse = (now = Date.now()) =>
    set((s) => {
      const nextPulse: TypingMap = {}
      let changed = false
      for (const [chatId, users] of Object.entries(s.inputPulse)) {
        const nextUsers: Record<string, { username: string; expiresAt: number }> = {}
        for (const [uid, state] of Object.entries(users)) {
          if (state.expiresAt > now) nextUsers[uid] = state
          else changed = true
        }
        if (Object.keys(nextUsers).length > 0) nextPulse[chatId] = nextUsers
        else changed = true
      }
      return changed ? { inputPulse: nextPulse } : s
    })

  const updatePeerStatus = (uid: string, status: { online: boolean; last_seen_at: string | null }) =>
    set((s) => ({ peerStatus: { ...s.peerStatus, [uid]: status } }))

  const batchUpdateStatus = (rows: { id: string; online: boolean; last_seen_at: string | null }[]) =>
    set((s) => {
      const nextStatus = { ...s.peerStatus }
      rows.forEach((r) => { nextStatus[r.id] = { online: r.online, last_seen_at: r.last_seen_at } })
      return { peerStatus: nextStatus }
    })

  const markNodeRead = (nodeId: string, timestamp: string) =>
    set((s) => ({
      readOverrides: { ...s.readOverrides, [nodeId]: timestamp },
      nodes: s.nodes.map((n) => n.id === nodeId ? { ...n, read_at: timestamp } : n),
    }))

  const setDecryptStatus = (busy: boolean) => set({ isDecrypting: busy })

  const resetProtocol = () =>
    set({
      activeChatId: null,
      userId: null,
      vaultKey: null,
      nodes: [],
      replyFocus: null,
      inputPulse: {},
      peerStatus: {},
      readOverrides: {},
      isDecrypting: false,
    })

  return {
    activeChatId: null,
    userId: null,
    vaultKey: null,
    nodes: [],
    replyFocus: null,
    inputPulse: {},
    peerStatus: {},
    readOverrides: {},
    isDecrypting: false,

    // Core actions
    setActiveChat,
    setNodes,
    pushNode,
    evictNode,
    pruneExpiredNodes,
    setReplyFocus,
    setVaultKey,
    setUserId,
    registerInputPulse,
    clearInputPulse,
    purgeGlobalInputPulse,
    gcInputPulse,
    updatePeerStatus,
    batchUpdateStatus,
    markNodeRead,
    setDecryptStatus,
    resetProtocol,

    // Consumer aliases (actions)
    setActiveChatId: setActiveChat,
    removeMessage: evictNode,
    setReplyTo: setReplyFocus,
    setUnwrappedPrivateKey: setVaultKey,
    pruneBurnedMessages: pruneExpiredNodes,
    updateMessageReadAt: markNodeRead,
    setPeerPresence: updatePeerStatus,
    mergePeerPresenceBatch: batchUpdateStatus,
    appendMessage: pushNode,
    setTypingUser: registerInputPulse,
    clearTypingUser: clearInputPulse,
    clearTypingUserEverywhere: purgeGlobalInputPulse,
    pruneTypingUsers: gcInputPulse,
    setMessages: setNodes,
    setHistoryDecryptBusy: setDecryptStatus,
    reset: resetProtocol,

    // Consumer aliases (state - initial values, kept in sync via selectors)
    unwrappedPrivateKey: null,
    messages: [],
    readAtOverrides: {},
    replyTo: null,
    peerPresence: {},
    typingUsers: {},
    historyDecryptBusy: false,
  }
})

// Keep consumer alias state fields in sync after each state change
useChatStore.subscribe((state) => {
  const needsSync =
    state.unwrappedPrivateKey !== state.vaultKey ||
    state.messages !== state.nodes ||
    state.readAtOverrides !== state.readOverrides ||
    state.replyTo !== state.replyFocus ||
    state.peerPresence !== state.peerStatus ||
    state.typingUsers !== state.inputPulse ||
    state.historyDecryptBusy !== state.isDecrypting

  if (needsSync) {
    useChatStore.setState({
      unwrappedPrivateKey: state.vaultKey,
      messages: state.nodes,
      readAtOverrides: state.readOverrides,
      replyTo: state.replyFocus,
      peerPresence: state.peerStatus,
      typingUsers: state.inputPulse,
      historyDecryptBusy: state.isDecrypting,
    }, false)
  }
})
