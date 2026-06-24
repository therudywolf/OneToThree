'use client'

import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { buildMentionReplacement } from '@/lib/composer-format'
import { parseMentionTrigger, type MentionMember } from '@/components/chat/mentions-popover'

/**
 * @mention autocomplete for the composer, extracted from chat-input (Wave C).
 * Owns the popover state, lazy member loading, trigger detection on text change,
 * selection (pure text splice via buildMentionReplacement), and popover keyboard
 * navigation. `onKeyDown` returns whether it handled the event so the textarea
 * keydown preserves its ordering (mention nav → format → Enter-send): when the
 * popover is open it consumes Arrow/Escape/Enter-on-a-match, but Enter with no
 * match falls through (returns false) so the message still sends.
 */
export function useMentions(opts: {
  activeChatId: string | null
  messageText: string
  setMessageText: (value: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const { activeChatId, messageText, setMessageText, inputRef } = opts
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionTriggerStart, setMentionTriggerStart] = useState(0)
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0)
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([])
  // Lazily loaded from the chat detail endpoint when the first @ is typed.
  const loadedRef = useRef(false)

  /** Reset the lazy-load flag (call on chat switch). */
  const resetLoaded = useCallback(() => {
    loadedRef.current = false
  }, [])

  const loadMembers = useCallback(async () => {
    if (!activeChatId || loadedRef.current) return
    loadedRef.current = true
    try {
      const { fetchChatDetail } = await import('@/lib/api/chats')
      const detail = await fetchChatDetail(activeChatId)
      setMentionMembers(
        (detail.members ?? []).map((m) => ({
          userId: m.user_id,
          username: m.username ?? m.user_id.slice(0, 8),
          displayName: m.username,
        }))
      )
    } catch {
      // Non-fatal: autocomplete just won't show.
    }
  }, [activeChatId])

  /** Detect/clear the @mention trigger when the composer text changes. */
  const onTextChange = useCallback(
    (text: string, cursorPos: number) => {
      const parsed = parseMentionTrigger(text, cursorPos)
      if (parsed.trigger) {
        void loadMembers()
        setMentionOpen(true)
        setMentionQuery(parsed.query)
        setMentionTriggerStart(parsed.triggerStart)
        setMentionActiveIdx(0)
      } else {
        setMentionOpen(false)
      }
    },
    [loadMembers]
  )

  const selectMember = useCallback(
    (member: MentionMember) => {
      setMentionOpen(false)
      const { text, caret } = buildMentionReplacement(
        messageText,
        mentionTriggerStart,
        mentionQuery,
        member.username
      )
      setMessageText(text)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        try {
          el.setSelectionRange(caret, caret)
        } catch {
          /* noop */
        }
        el.focus()
      })
    },
    [messageText, mentionTriggerStart, mentionQuery, setMessageText, inputRef]
  )

  /** Returns true when the popover consumed the key (caller should return). */
  const onKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!mentionOpen) return false
      const filtered = mentionQuery
        ? mentionMembers.filter(
            (m) =>
              m.username.toLowerCase().startsWith(mentionQuery.toLowerCase()) ||
              (m.displayName?.toLowerCase().startsWith(mentionQuery.toLowerCase()) ?? false)
          )
        : mentionMembers.slice(0, 8)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionActiveIdx((i) => (i + 1) % Math.max(filtered.length, 1))
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionActiveIdx((i) => (i - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1))
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const chosen = filtered[mentionActiveIdx]
        if (chosen) {
          e.preventDefault()
          selectMember(chosen)
          return true
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionOpen(false)
        return true
      }
      return false
    },
    [mentionOpen, mentionQuery, mentionMembers, mentionActiveIdx, selectMember]
  )

  return {
    mentionOpen,
    mentionQuery,
    mentionMembers,
    mentionActiveIdx,
    setMentionOpen,
    onTextChange,
    selectMember,
    onKeyDown,
    resetLoaded,
  }
}
