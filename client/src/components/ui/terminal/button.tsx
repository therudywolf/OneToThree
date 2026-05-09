'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'

export type TerminalButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

type TerminalButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: TerminalButtonVariant
  block?: boolean
}

const BASE =
  'inline-flex min-h-10 items-center justify-center gap-2 border px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] transition-[background,color,border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/70 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px'

const VARIANTS: Record<TerminalButtonVariant, string> = {
  primary:
    'border-neon-cyan/70 bg-neon-cyan/12 text-neon-cyan shadow-[0_0_14px_color-mix(in_srgb,var(--neon-cyan)_18%,transparent)] hover:bg-neon-cyan/20',
  secondary:
    'border-border-strong bg-surface text-text-primary hover:border-neon-cyan/70 hover:text-neon-cyan',
  ghost:
    'border-transparent bg-transparent text-text-muted hover:border-border-strong hover:bg-surface/60 hover:text-text-primary',
  danger:
    'border-neon-red/70 bg-neon-red/10 text-neon-red hover:bg-neon-red/18',
}

export const TerminalButton = forwardRef<HTMLButtonElement, TerminalButtonProps>(
  function TerminalButton({ variant = 'primary', block, className = '', ...rest }, ref) {
    return (
      <button
        ref={ref}
        {...rest}
        className={`${BASE} ${VARIANTS[variant]} ${block ? 'w-full' : ''} ${className}`.trim()}
      />
    )
  }
)
