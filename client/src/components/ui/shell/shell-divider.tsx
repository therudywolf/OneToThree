'use client'

import type { HTMLAttributes } from 'react'
import { useShell } from './use-shell'

type Props = HTMLAttributes<HTMLDivElement> & {
  label?: string
  tone?: 'muted' | 'accent'
}

/**
 * Horizontal separator — thin neon line + centred uppercase label under
 * terminal, soft gray rule + sentence-case label under MD3.
 */
export function ShellDivider({
  label,
  tone = 'muted',
  className = '',
  ...rest
}: Props) {
  const { isTerminal } = useShell()

  if (!label) {
    return (
      <div
        className={`h-px w-full ${
          isTerminal
            ? 'bg-[color-mix(in_srgb,var(--neon-cyan)_25%,transparent)]'
            : 'bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
        } ${className}`}
        {...rest}
      />
    )
  }

  const terminalLabel =
    tone === 'accent'
      ? 'text-[9px] uppercase tracking-[0.35em] text-neon-cyan'
      : 'text-[9px] uppercase tracking-[0.35em] text-text-muted/80'
  const md3Label =
    tone === 'accent'
      ? 'text-[11px] font-medium tracking-normal text-[var(--neon-cyan)]'
      : 'text-[11px] tracking-normal text-[color-mix(in_srgb,var(--on-surface)_60%,transparent)]'

  return (
    <div className={`flex items-center gap-3 ${className}`} {...rest}>
      <span
        className={`h-px flex-1 ${
          isTerminal
            ? 'bg-[color-mix(in_srgb,var(--neon-cyan)_25%,transparent)]'
            : 'bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
        }`}
      />
      <span className={isTerminal ? terminalLabel : md3Label}>{label}</span>
      <span
        className={`h-px flex-1 ${
          isTerminal
            ? 'bg-[color-mix(in_srgb,var(--neon-cyan)_25%,transparent)]'
            : 'bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
        }`}
      />
    </div>
  )
}
