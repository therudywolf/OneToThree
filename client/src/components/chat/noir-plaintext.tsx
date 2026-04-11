'use client'

import { useMemo } from 'react'
import emojiRegex from 'emoji-regex'

type Props = { text: string; className?: string }

/** Wraps emoji code points in spans for noir CSS filter (terminal aesthetic). */
export function NoirPlaintext({ text, className = '' }: Props) {
  const parts = useMemo(() => {
    const re = emojiRegex()
    const out: React.ReactNode[] = []
    let last = 0
    let k = 0
    for (const m of text.matchAll(re)) {
      const match = m[0]
      const i = m.index ?? 0
      if (i > last) {
        out.push(text.slice(last, i))
      }
      out.push(
        <span key={`e-${k++}`} className="noir-emoji-inline">
          {match}
        </span>
      )
      last = i + match.length
    }
    if (last < text.length) {
      out.push(text.slice(last))
    }
    return out
  }, [text])

  return <span className={className}>{parts}</span>
}
