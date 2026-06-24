'use client'

import { useCallback, useState, type KeyboardEvent, type RefObject } from 'react'
import { wrapSelection } from '@/lib/composer-format'

/**
 * Composer markdown-format toolbar + hotkeys, extracted from chat-input
 * (Wave C). Owns the selection-toolbar position state and the Ctrl/Cmd+B/I/`
 * wrapping. The pure text transform lives in `wrapSelection` (node-tested); only
 * the caret application + toolbar geometry stay here (jsdom-fragile, so not
 * unit-asserted). `onFormatKeyDown` returns whether it handled the event so the
 * textarea's keydown can keep its early-return ordering (mention nav → format →
 * Enter-send).
 */
export function useFormatBar(opts: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  containerRef: RefObject<HTMLElement | null>
  setMessageText: (value: string) => void
  onDraftChanged: (value: string) => void
}) {
  const { inputRef, containerRef, setMessageText, onDraftChanged } = opts
  const [formatToolbar, setFormatToolbar] = useState<{
    visible: boolean
    top: number
    left: number
  }>({ visible: false, top: 0, left: 0 })

  const applyFormat = useCallback(
    (tag: string) => {
      const ta = inputRef.current
      if (!ta) return
      const res = wrapSelection(ta.value, ta.selectionStart, ta.selectionEnd, tag)
      if (!res) return
      setMessageText(res.text)
      onDraftChanged(res.text)
      requestAnimationFrame(() => {
        ta.focus()
        ta.selectionStart = res.selStart
        ta.selectionEnd = res.selEnd
      })
      setFormatToolbar((prev) => ({ ...prev, visible: false }))
    },
    [inputRef, setMessageText, onDraftChanged]
  )

  const handleTextareaSelect = useCallback(() => {
    const ta = inputRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) {
      setFormatToolbar((prev) => ({ ...prev, visible: false }))
      return
    }
    // Position toolbar above the textarea.
    const rect = ta.getBoundingClientRect()
    const formRect = containerRef.current?.getBoundingClientRect()
    if (!formRect) return
    const relTop = rect.top - formRect.top - 44 // 44px toolbar height + gap
    const relLeft = Math.max(0, rect.left - formRect.left)
    setFormatToolbar({ visible: true, top: relTop, left: relLeft })
  }, [inputRef, containerRef])

  /** Delay hide on blur so a toolbar click can fire first. */
  const hideToolbarSoon = useCallback(() => {
    setTimeout(() => setFormatToolbar((prev) => ({ ...prev, visible: false })), 150)
  }, [])

  /** Returns true when the format hotkey was handled (caller should return). */
  const onFormatKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!(e.ctrlKey || e.metaKey)) return false
      if (e.key === 'b') {
        e.preventDefault()
        applyFormat('**')
        return true
      }
      if (e.key === 'i') {
        e.preventDefault()
        applyFormat('_')
        return true
      }
      if (e.key === '`') {
        e.preventDefault()
        applyFormat('`')
        return true
      }
      return false
    },
    [applyFormat]
  )

  return { formatToolbar, applyFormat, handleTextareaSelect, hideToolbarSoon, onFormatKeyDown }
}
