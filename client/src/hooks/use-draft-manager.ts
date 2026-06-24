'use client'

import { useCallback, useEffect } from 'react'
import { clearDraft, loadDraft, saveDraftDebounced } from '@/lib/chat-drafts'

/**
 * Owns the composer's per-chat draft lifecycle, extracted from chat-input
 * (Wave C). On active-chat change it clears staged composer state that would
 * otherwise leak across chats — a staged reply / in-progress edit (global
 * chatStore) sent/applied to the WRONG chat, or an armed burn timer that
 * silently self-destructs messages in a chat where it was never set — then
 * loads the new chat's draft. The composer is not keyed by chat, so it never
 * remounts on switch; this reset must be explicit. Behaviour is pinned by the
 * chat-input characterization net (the chat-switch reset test).
 */
export function useDraftManager(opts: {
  activeChatId: string | null
  setMessageText: (value: string) => void
  setReplyTo: (value: null) => void
  setEditingMessage: (value: null) => void
  setBurnTimerSecs: (value: null) => void
  /** Extra per-switch reset (e.g. mention-members cache flag). */
  onChatSwitch?: () => void
}): { persistDraft: (next: string) => void; clearActiveDraft: () => void } {
  const {
    activeChatId,
    setMessageText,
    setReplyTo,
    setEditingMessage,
    setBurnTimerSecs,
    onChatSwitch,
  } = opts

  useEffect(() => {
    if (!activeChatId) return
    setReplyTo(null)
    setEditingMessage(null)
    setBurnTimerSecs(null)
    setMessageText(loadDraft(activeChatId))
    onChatSwitch?.()
    // Only re-run on chat switch — the setters are stable.
  }, [activeChatId])

  const persistDraft = useCallback(
    (next: string) => {
      if (activeChatId) saveDraftDebounced(activeChatId, next)
    },
    [activeChatId]
  )

  const clearActiveDraft = useCallback(() => {
    if (activeChatId) clearDraft(activeChatId)
  }, [activeChatId])

  return { persistDraft, clearActiveDraft }
}
