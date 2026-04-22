'use client'

import { useState, useMemo } from 'react'
import { useTranslation } from '@/hooks/use-translation'

const MAX_LINES = 20

type Props = {
  text: string
  children: (visibleText: string) => React.ReactNode
}

export function CollapsibleText({ text, children }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const { shouldCollapse, truncated } = useMemo(() => {
    const lines = text.split('\n')
    if (lines.length <= MAX_LINES) return { shouldCollapse: false, truncated: text }
    return {
      shouldCollapse: true,
      truncated: lines.slice(0, MAX_LINES).join('\n') + '\u2026',
    }
  }, [text])

  if (!shouldCollapse) return <>{children(text)}</>

  return (
    <div>
      {children(expanded ? text : truncated)}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setExpanded((prev) => !prev)
        }}
        className="mt-1 block font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70 hover:text-neon-cyan transition-colors"
      >
        [ {expanded ? t('msg.showLess') : t('msg.showMore')} ]
      </button>
    </div>
  )
}
