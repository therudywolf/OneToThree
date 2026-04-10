'use client'

import { useState } from 'react'
import { useChatStore } from '@/store/chatStore'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

type Props = {
  sendText: (t: string, replyToId?: string | null) => Promise<void>
  disabled?: boolean
}

export function ChatInput({ sendText, disabled }: Props) {
  const [value, setValue] = useState('')
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim() || disabled) return
    await sendText(value, replyTo?.id ?? null)
    setValue('')
    setReplyTo(null)
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="shrink-0 border-t border-neon-cyan/40 bg-black p-2"
    >
      {replyTo ? (
        <div className="mb-2 flex items-center gap-2 border-l-2 border-neon-cyan/50 pl-2">
          <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-neon-cyan/70">
            ↳ {replyTo.plaintext ? replyTo.plaintext.slice(0, 80) : '[MEDIA]'}
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
      <div className="flex items-center gap-2">
        <span className="shrink-0 select-none font-mono text-neon-cyan">&gt;_</span>
        <input
          className="terminal-input flex-1 text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          aria-label="Message input"
          placeholder="type encrypted message"
          autoComplete="off"
          spellCheck={false}
        />
        <TerminalGlitchButton
          type="submit"
          disabled={disabled || !value.trim()}
        >
          [ TX ]
        </TerminalGlitchButton>
      </div>
    </form>
  )
}
