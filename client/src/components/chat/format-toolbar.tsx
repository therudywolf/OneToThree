'use client'

import { Bold, Italic, Code, Strikethrough } from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'

interface FormatToolbarProps {
  onFormat: (tag: string) => void
  visible: boolean
  position: { top: number; left: number }
}

export function FormatToolbar({ onFormat, visible, position }: FormatToolbarProps) {
  const isMd3 = useThemeStore((s) => s.shellMode) === 'md3'

  if (!visible) return null

  const buttons = [
    { icon: Bold, tag: '**', label: 'Bold (Ctrl+B)' },
    { icon: Italic, tag: '_', label: 'Italic (Ctrl+I)' },
    { icon: Code, tag: '`', label: 'Code (Ctrl+`)' },
    { icon: Strikethrough, tag: '~~', label: 'Strikethrough' },
  ]

  return (
    <div
      className={`absolute z-50 flex items-center gap-0.5 p-1 shadow-lg ${
        isMd3
          ? 'rounded-xl border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface-container-high)]'
          : 'border border-neon-cyan/40 bg-void shadow-[0_4px_16px_rgba(0,0,0,0.8)]'
      }`}
      style={{ top: position.top, left: position.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {buttons.map(({ icon: Icon, tag, label }) => (
        <button
          key={tag}
          type="button"
          title={label}
          aria-label={label}
          onMouseDown={(e) => {
            e.preventDefault()
            onFormat(tag)
          }}
          className={`rounded p-1.5 transition-colors ${
            isMd3
              ? 'text-[var(--on-surface-variant)] hover:bg-[var(--state-hover)] hover:text-[var(--on-surface)]'
              : 'text-neon-cyan/60 hover:bg-neon-cyan/10 hover:text-neon-cyan'
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  )
}
