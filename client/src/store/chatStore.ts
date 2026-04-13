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

type ChatState = {
  // [IDENT_LAYER]
  activeChatId: string | null
  userId: string | null
  vaultKey: CryptoKey | null // Приватный ключ, развернутый в памяти

  // [DATA_LAYER]
  nodes: DecryptedMessage[]
  replyFocus: DecryptedMessage | null
  
  // [PRESENCE_LAYER]
  inputPulse: Record<string, Record<string, { username: string; expiresAt: number }>>
  peerStatus: Record<string, { online: boolean; last_seen_at: string | null }>
  
  // [SYNC_LAYER]
  readOverrides: Record<string, string>
  isDecrypting: boolean

  // [ACTIONS]
  setActiveChat: (id: string | null) => void
  setNodes: (nodes: DecryptedMessage[]) => void
  pushNode: (node: DecryptedMessage) => void
  evictNode: (id: string) => void
  
  /** Ликвидация узлов с истекшим сроком жизни (Burn-at) */
  pruneExpiredNodes: (now?: number) => void
  
  setReplyFocus: (node: DecryptedMessage | null) => void
  setVaultKey: (key: CryptoKey | null) => void
  setUserId: (id: string | null) => void
  
  // Typing mechanics
  registerInputPulse: (chatId: string, uid: string, uname: string, ttl?: number) => void
  clearInputPulse: (chatId: string, uid: string) => void
  purgeGlobalInputPulse: (uid: string) => void
  gcInputPulse: (now?: number) => void
  
  updatePeerStatus: (uid: string, status: { online: boolean; last_seen_at: string | null }) => void
  batchUpdateStatus: (rows: { id: string; online: boolean; last_seen_at: string | null }[]) => void
  
  markNodeRead: (nodeId: string, timestamp: string) => void
  setDecryptStatus: (busy: boolean) => void
  
  /** Полная стерилизация контура */
  resetProtocol: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  activeChatId: null,
  userId: null,
  vaultKey: null,
  nodes: [],
  replyFocus: null,
  inputPulse: {},
  peerStatus: {},
  readOverrides: {},
  isDecrypting: false,

  setActiveChat: (id) =>
    set({ 
      activeChatId: id, 
      replyFocus: null, 
      readOverrides: {}, 
      isDecrypting: false 
    }),

  setNodes: (nodes) =>
    set({ nodes: enforceMemoryLimit(sortNodes(nodes)) }),

  pushNode: (node) =>
    set((s) => {
      if (s.nodes.some((x) => x.id === node.id)) return s
      return { nodes: enforceMemoryLimit(sortNodes([...s.nodes, node])) }
    }),

  evictNode: (id) =>
    set((s) => ({ nodes: s.nodes.filter((n) => n.id !== id) })),

  pruneExpiredNodes: (now = Date.now()) =>
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
    }),

  setReplyFocus: (node) => set({ replyFocus: node }),
  setVaultKey: (key) => set({ vaultKey: key }),
  setUserId: (id) => set({ userId: id }),

  registerInputPulse: (chatId, uid, uname, ttl = 3000) =>
    set((s) => ({
      inputPulse: {
        ...s.inputPulse,
        [chatId]: {
          ...(s.inputPulse[chatId] ?? {}),
          [uid]: { username: uname, expiresAt: Date.now() + ttl },
        },
      },
    })),

  clearInputPulse: (chatId, uid) =>
    set((s) => {
      const bucket = { ...(s.inputPulse[chatId] ?? {}) }
      delete bucket[uid]
      const nextPulse = { ...s.inputPulse }
      if (Object.keys(bucket).length === 0) delete nextPulse[chatId]
      else nextPulse[chatId] = bucket
      return { inputPulse: nextPulse }
    }),

  purgeGlobalInputPulse: (uid) =>
    set((s) => {
      const nextPulse: ChatState['inputPulse'] = {}
      for (const [chatId, users] of Object.entries(s.inputPulse)) {
        const nextUsers = { ...users }
        delete nextUsers[uid]
        if (Object.keys(nextUsers).length > 0) nextPulse[chatId] = nextUsers
      }
      return { inputPulse: nextPulse }
    }),

  gcInputPulse: (now = Date.now()) =>
    set((s) => {
      const nextPulse: ChatState['inputPulse'] = {}
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
    }),

  updatePeerStatus: (uid, status) =>
    set((s) => ({
      peerStatus: { ...s.peerStatus, [uid]: status },
    })),

  batchUpdateStatus: (rows) =>
    set((s) => {
      const nextStatus = { ...s.peerStatus }
      rows.forEach((r) => { nextStatus[r.id] = { online: r.online, last_seen_at: r.last_seen_at } })
      return { peerStatus: nextStatus }
    }),

  markNodeRead: (nodeId, timestamp) =>
    set((s) => ({
      readOverrides: { ...s.readOverrides, [nodeId]: timestamp },
      nodes: s.nodes.map((n) => n.id === nodeId ? { ...n, read_at: timestamp } : n),
    })),

  setDecryptStatus: (busy) => set({ isDecrypting: busy }),

  resetProtocol: () =>
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
    }),
}))