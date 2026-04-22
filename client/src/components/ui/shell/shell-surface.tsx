'use client'

import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { useShell } from './use-shell'

type Variant = 'panel' | 'elevated' | 'inline' | 'sunken'

type Props = HTMLAttributes<HTMLDivElement> & {
  variant?: Variant
  as?: 'div' | 'section' | 'article' | 'aside'
  children?: ReactNode
}

/**
 * A surface primitive that renders with shell-aware border radius, padding
 * and shadow tokens. Terminal shell gives you a sharp-cornered panel with a
 * neon inset glow; MD3 gives you a rounded Material card with soft elevation.
 *
 * Use for: modal bodies, dock panels, welcome-screen cards, sidebar sections.
 * Don't use for bubbles (they have their own stream-animated primitive).
 */
export const ShellSurface = forwardRef<HTMLDivElement, Props>(function ShellSurface(
  { variant = 'panel', as: As = 'div', className = '', children, style, ...rest },
  ref
) {
  const { isTerminal } = useShell()

  // Terminal classes: sharp, neon-lined, CRT-flavored.
  // MD3 classes: rounded, Material elevation, calmer borders.
  const base = {
    panel: isTerminal
      ? 'rounded-none border border-border-strong bg-surface shadow-[0_0_0_1px_color-mix(in_srgb,var(--border-strong)_65%,transparent),0_0_20px_color-mix(in_srgb,var(--neon-cyan)_10%,transparent)]'
      : 'rounded-[var(--radius-lg,20px)] border border-border-strong/60 bg-surface shadow-[0_2px_12px_rgba(0,0,0,0.14),0_1px_3px_rgba(0,0,0,0.08)]',
    elevated: isTerminal
      ? 'rounded-none border border-border-strong bg-surface-elevated shadow-[0_0_0_1px_color-mix(in_srgb,var(--border-strong)_80%,transparent),0_0_28px_color-mix(in_srgb,var(--neon-cyan)_14%,transparent)]'
      : 'rounded-[var(--radius-lg,24px)] border border-border-strong/40 bg-surface-elevated shadow-[0_8px_24px_rgba(0,0,0,0.18),0_2px_6px_rgba(0,0,0,0.10)]',
    inline: isTerminal
      ? 'rounded-none border border-border-strong/60 bg-void/70'
      : 'rounded-[var(--radius-md,14px)] border border-border-strong/30 bg-surface/80',
    sunken: isTerminal
      ? 'rounded-none border border-neon-cyan/20 bg-void'
      : 'rounded-[var(--radius-md,12px)] border border-border-strong/30 bg-[color-mix(in_srgb,var(--surface)_92%,var(--void))]',
  }[variant]

  return (
    <As
      ref={ref as never}
      className={`${base} ${className}`.trim()}
      style={style}
      {...rest}
    >
      {children}
    </As>
  )
})
