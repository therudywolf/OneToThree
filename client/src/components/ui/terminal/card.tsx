'use client'

import { forwardRef, type HTMLAttributes } from 'react'

export type TerminalCardVariant = 'panel' | 'elevated' | 'sunken'

type TerminalCardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: TerminalCardVariant
  interactive?: boolean
}

const VARIANTS: Record<TerminalCardVariant, string> = {
  panel:
    'border-border-strong bg-surface text-text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--neon-cyan)_18%,transparent)]',
  elevated:
    'border-neon-cyan/50 bg-surface-elevated text-text-primary shadow-[0_0_24px_color-mix(in_srgb,var(--neon-cyan)_14%,transparent)]',
  sunken:
    'border-neon-cyan/20 bg-void text-text-primary shadow-[inset_0_0_18px_rgba(0,0,0,0.55)]',
}

export const TerminalCard = forwardRef<HTMLDivElement, TerminalCardProps>(
  function TerminalCard({ variant = 'panel', interactive, className = '', ...rest }, ref) {
    const hover = interactive
      ? 'transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-neon-cyan/70'
      : ''
    return (
      <div
        ref={ref}
        {...rest}
        className={`rounded-none border p-4 ${VARIANTS[variant]} ${hover} ${className}`.trim()}
      />
    )
  }
)
