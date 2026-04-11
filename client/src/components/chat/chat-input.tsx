'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/store/chatStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTypingIndicator } from '@/hooks/use-typing-indicator'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  sendText: (t: string, replyToId?: string | null) => Promise<void>
  disabled?: boolean
}

/** Curated grid — lightweight, no heavy emoji font bundle */
const EMOJI_PRESET = [
  '😀',
  '😅',
  '😐',
  '🙂',
  '😈',
  '👍',
  '👎',
  '🔥',
  '💀',
  '⚡',
  '✨',
  '🖤',
  '❤️',
  '✅',
  '❌',
  '❓',
  '⚠️',
  '➡️',
  '📎',
  '🔐',
]

export function ChatInput({ sendText, disabled }: Props) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const { onDraftChanged, onSubmitOrClear } = useTypingIndicator()

  useEffect(() => {
    if (!emojiOpen) return
    const close = () => setEmojiOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [emojiOpen])

  function insertEmoji(ch: string) {
    setValue((prev) => {
      const el = inputRef.current
      let next: string
      if (!el) {
        next = prev + ch
      } else {
        const start = el.selectionStart ?? prev.length
        const end = el.selectionEnd ?? prev.length
        next = prev.slice(0, start) + ch + prev.slice(end)
        queueMicrotask(() => {
          const pos = start + ch.length
          el.focus()
          try {
            el.setSelectionRange(pos, pos)
          } catch {
            /* ignore */
          }
        })
      }
      onDraftChanged(next)
      return next
    })
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim() || disabled) return
    await sendText(value, replyTo?.id ?? null)
    onSubmitOrClear()
    setValue('')
    setReplyTo(null)
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="relative shrink-0 touch-manipulation border-t border-neon-cyan/40 bg-black p-2"
    >
      {replyTo ? (
        <div className="mb-2 flex items-center gap-2 border-l-2 border-neon-cyan/50 pl-2">
          <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-neon-cyan/70">
            ↳ {t('chat.replyBanner')}:{' '}
            {replyTo.plaintext ? replyTo.plaintext.slice(0, 80) : '[MEDIA]'}
          </p>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            className="shrink-0 font-mono text-[10px] text-red-800 hover:text-neon-red"
          >
            [X]
          </button>
        </div>
      ) : null}
      {emojiOpen ? (
        <div
          className="relative z-10 mb-2 flex max-h-28 flex-wrap gap-1 overflow-y-auto border border-neon-cyan/50 bg-black p-2 shadow-[inset_0_0_12px_rgba(0,255,255,0.08)]"
          role="listbox"
          aria-label={t('emoji.pickerAria')}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {EMOJI_PRESET.map((ch, i) => (
            <button
              key={`${i}-${ch}`}
              type="button"
              className="flex h-9 w-9 items-center justify-center border border-transparent font-mono text-lg leading-none hover:border-neon-cyan/60 hover:bg-neon-cyan/5"
              onClick={() => insertEmoji(ch)}
            >
              <span className="noir-emoji-inline">{ch}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="shrink-0 border border-neon-cyan/50 bg-black px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
          disabled={disabled}
          aria-label={t('emoji.pickerAria')}
          aria-expanded={emojiOpen}
          onMouseDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          onClick={() => setEmojiOpen((o) => !o)}
        >
          [ {t('emoji.pickerToggle')} ]
        </button>
        <span className="shrink-0 select-none font-mono text-neon-cyan">&gt;_</span>
        <input
          ref={inputRef}
          className="terminal-input flex-1 text-sm"
          value={value}
          onChange={(e) => {
            const next = e.target.value
            setValue(next)
            onDraftChanged(next)
          }}
          disabled={disabled}
          aria-label={t('chat.inputPlaceholder')}
          placeholder={t('chat.inputPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
        <TerminalGlitchButton
          type="submit"
          disabled={disabled || !value.trim()}
          className="min-h-11 min-w-[44px] shrink-0 px-4 py-2 md:min-h-0 md:min-w-0"
        >
          [ TX ]
        </TerminalGlitchButton>
      </div>
    </form>
  )
}
