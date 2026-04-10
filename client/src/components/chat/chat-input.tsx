'use client'

import { useState } from 'react'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

type Props = {
  sendText: (t: string) => Promise<void>
  disabled?: boolean
}

export function ChatInput({ sendText, disabled }: Props) {
  const [value, setValue] = useState('')

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim() || disabled) return
    await sendText(value)
    setValue('')
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="shrink-0 border-t border-neon-cyan/40 bg-black p-2"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 select-none font-mono text-neon-cyan">&gt;_</span>
        <input
          className="terminal-input flex-1 text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
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
