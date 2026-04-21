import { create } from 'zustand'
import { deleteCachedMessage } from '@/lib/message-cache'
import type { DecryptedMessage } from '@/types/chat'
import { useSessionStore } from './sessionStore'
import { usePresenceStore } from './presenceStore'
import { useUnreadStore } from './unreadStore'

/**
 * PROJECT 13 :: CHAT_PULSE_CORE
 * Level: Message Layer (Volatile RAM)
 * Vibe: Clinical Steel / Zero-Trust Trace
 *
 * Reduced store: owns messages, replyTo, editingMessage, chatSoundEnabled.
 * Session state → sessionStore
 * Presence state → presenceStore
 * Unread state → unreadStore
 */

const RAM_CACHE_LIMIT = 50

const sortNodes = (nodes: DecryptedMessage[]): DecryptedMessage[] => {
  return [...nodes].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )
}

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

// Re-export shared types for backward compat
export type PeerStatusMap = Record<string, { online: boolean; last_seen_at: string | null }>
export type TypingMap = Record<string, Record<string, { username: string; expiresAt: number }>>
export type ThreadUnreadMap = Record<string, number>
export type ChatUnreadState = {
  total: number
  mentions: number
  threads: ThreadUnreadMap
}
export type UnreadByChat = Record<string, ChatUnreadState>

export type ChatState = {
  // [DATA_LAYER]
  messages: DecryptedMessage[]
  replyTo: DecryptedMessage | null
  editingMessage: DecryptedMessage | null

  // [SOUND]
  chatSoundEnabled: boolean

  // [ACTIONS]
  setMessages: (nodes: DecryptedMessage[]) => void
  appendMessage: (node: DecryptedMessage) => void
  removeMessage: (id: string) => void
  pruneBurnedMessages: (now?: number) => void
  setReplyTo: (node: DecryptedMessage | null) => void
  setEditingMessage: (node: DecryptedMessage | null) => void
  updateMessageReadAt: (nodeId: string, timestamp: string) => void
  updateMessageReactions: (nodeId: string, reactions: Record<string, string[]>) => void
  setChatSoundEnabled: (enabled: boolean) => void
  /** Resets message layer; also resets all sub-stores. */
  reset: () => void
}

export const useChatStore = create<ChatState>((set, get) => {
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
  const setEditingMessage = (node: DecryptedMessage | null) => set({ editingMessage: node })

  const updateMessageReadAt = (nodeId: string, timestamp: string) => {
    set((s) => ({
      messages: s.messages.map((n) => n.id === nodeId ? { ...n, read_at: timestamp } : n),
    }))
    useUnreadStore.getState().updateReadAtOverride(nodeId, timestamp)
  }

  const updateMessageReactions = (nodeId: string, reactions: Record<string, string[]>) =>
    set((s) => ({
      messages: s.messages.map((n) => n.id === nodeId ? { ...n, reactions } : n),
    }))

  const setChatSoundEnabled = (enabled: boolean) => {
    try { localStorage.setItem(CHAT_SOUND_KEY, String(enabled)) } catch { /* ignore */ }
    set({ chatSoundEnabled: enabled })
  }

  const reset = () => {
    set({ messages: [], replyTo: null, editingMessage: null })
    useSessionStore.getState().reset()
    usePresenceStore.getState().reset()
    useUnreadStore.getState().reset()
  }

  return {
    messages: [],
    replyTo: null,
    editingMessage: null,
    chatSoundEnabled: loadChatSoundEnabled(),

    setMessages,
    appendMessage,
    removeMessage,
    pruneBurnedMessages,
    setReplyTo,
    setEditingMessage,
    updateMessageReadAt,
    updateMessageReactions,
    setChatSoundEnabled,
    reset,
  }
})
