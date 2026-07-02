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
const CHAT_SOUND_SCHEME_KEY = 'p13:chat_sound_scheme'

export type ChatSoundSchemeId = 'classic' | 'soft' | 'retro'

export const CHAT_SOUND_SCHEMES: Array<{ id: ChatSoundSchemeId; label: string }> = [
  { id: 'classic', label: 'Classic' },
  { id: 'soft', label: 'Soft' },
  { id: 'retro', label: 'Retro' },
]

function loadChatSoundEnabled(): boolean {
  try {
    const v = localStorage.getItem(CHAT_SOUND_KEY)
    return v === null ? true : v === 'true'
  } catch {
    return true
  }
}

function loadChatSoundScheme(): ChatSoundSchemeId {
  try {
    const v = localStorage.getItem(CHAT_SOUND_SCHEME_KEY)
    if (v === 'soft' || v === 'retro' || v === 'classic') return v
    return 'classic'
  } catch {
    return 'classic'
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
  chatSoundScheme: ChatSoundSchemeId

  // [ACTIONS]
  setMessages: (nodes: DecryptedMessage[]) => void
  appendMessage: (node: DecryptedMessage) => void
  removeMessage: (id: string) => void
  pruneBurnedMessages: (now?: number) => void
  setReplyTo: (node: DecryptedMessage | null) => void
  setEditingMessage: (node: DecryptedMessage | null) => void
  updateMessageReadAt: (nodeId: string, timestamp: string) => void
  updateMessageBurnAt: (nodeId: string, burnAt: string) => void
  updateMessageReactions: (nodeId: string, reactions: Record<string, string[]>) => void
  updateMessagePlaintext: (nodeId: string, plaintext: string, editedAt?: string) => void
  setChatSoundEnabled: (enabled: boolean) => void
  setChatSoundScheme: (scheme: ChatSoundSchemeId) => void
  /** Resets message layer; also resets all sub-stores. */
  reset: () => void
}

export const useChatStore = create<ChatState>((set) => {
  // A DR message key is one-time: concurrent receiver paths (history load,
  // realtime backlog, delivery sync) each ratchet-decrypt the same rows, and
  // whichever loses the race re-derives a consumed key and yields
  // '[DECRYPT_FAIL]' (or ''). Plaintext must therefore be MONOTONIC in the
  // store — a message that once decrypted cleanly must never regress to a
  // failure placeholder just because a slower path wrote last.
  // '[KEY_CHANGE_DETECTED]' is intentionally NOT treated as "bad": it is a real
  // security signal that must surface even over a previously-good plaintext.
  const isBadPlaintext = (p: string | null | undefined): boolean =>
    !p || p === '[DECRYPT_FAIL]'

  const setMessages = (nodes: DecryptedMessage[]) =>
    set((s) => {
      const prevById = new Map(s.messages.map((m) => [m.id, m]))
      const merged = nodes.map((n) => {
        const prev = prevById.get(n.id)
        if (prev && isBadPlaintext(n.plaintext) && !isBadPlaintext(prev.plaintext)) {
          return { ...n, plaintext: prev.plaintext }
        }
        return n
      })
      return { messages: enforceMemoryLimit(sortNodes(merged)) }
    })

  const appendMessage = (node: DecryptedMessage) =>
    set((s) => {
      const idx = s.messages.findIndex((x) => x.id === node.id)
      if (idx >= 0) {
        // Upgrade a failed/empty placeholder to a clean decrypt; never downgrade.
        const existing = s.messages[idx]
        if (isBadPlaintext(existing.plaintext) && !isBadPlaintext(node.plaintext)) {
          const next = s.messages.slice()
          next[idx] = { ...existing, plaintext: node.plaintext }
          return { messages: enforceMemoryLimit(sortNodes(next)) }
        }
        return s
      }
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
      expired.forEach((n) => void deleteCachedMessage(n.id, n.chat_id))
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

  const updateMessageBurnAt = (nodeId: string, burnAt: string) => {
    set((s) => ({
      messages: s.messages.map((n) => n.id === nodeId ? { ...n, burn_at: burnAt } : n),
    }))
  }

  const updateMessageReactions = (nodeId: string, reactions: Record<string, string[]>) =>
    set((s) => ({
      messages: s.messages.map((n) => n.id === nodeId ? { ...n, reactions } : n),
    }))

  const updateMessagePlaintext = (nodeId: string, plaintext: string, editedAt?: string) =>
    set((s) => ({
      messages: s.messages.map((n) =>
        n.id === nodeId
          ? { ...n, plaintext, ...(editedAt ? { edited_at: editedAt } : {}) }
          : n
      ),
    }))

  const setChatSoundEnabled = (enabled: boolean) => {
    try { localStorage.setItem(CHAT_SOUND_KEY, String(enabled)) } catch { /* ignore */ }
    set({ chatSoundEnabled: enabled })
  }

  const setChatSoundScheme = (scheme: ChatSoundSchemeId) => {
    try { localStorage.setItem(CHAT_SOUND_SCHEME_KEY, scheme) } catch { /* ignore */ }
    set({ chatSoundScheme: scheme })
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
    chatSoundScheme: loadChatSoundScheme(),

    setMessages,
    appendMessage,
    removeMessage,
    pruneBurnedMessages,
    setReplyTo,
    setEditingMessage,
    updateMessageReadAt,
    updateMessageBurnAt,
    updateMessageReactions,
    updateMessagePlaintext,
    setChatSoundEnabled,
    setChatSoundScheme,
    reset,
  }
})

// Reconcile offline optimistic placeholders: when the outbox confirms a queued
// message was sent (outbox.ts), drop its `pending-<outboxId>` row. The real
// message arrives via its normal inbound path (WS / pending-pull).
if (typeof window !== 'undefined') {
  window.addEventListener('p13:outbox_flushed', (e) => {
    const outboxId = (e as CustomEvent<{ outboxId?: string }>).detail?.outboxId
    if (outboxId) useChatStore.getState().removeMessage(`pending-${outboxId}`)
  })
}
