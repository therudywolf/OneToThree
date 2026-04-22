'use client'

import { forwardRef, type HTMLAttributes } from 'react'

/**
 * MD3 Card — filled / outlined / elevated surface.
 * Uses `--surface`, `--surface-elevated`, `--border-strong`, and the
 * shell-driven `--border-radius` so that switching `data-shell="md3"`
 * automatically rounds corners without any markup changes.
 */
export type Md3CardVariant = 'filled' | 'outlined' | 'elevated'

type Md3CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: Md3CardVariant
  interactive?: boolean
}

const BASE = 'relative rounded-[var(--border-radius)] p-4'

const VARIANTS: Record<Md3CardVariant, string> = {
  filled:
    'bg-surface text-on-surface',
  outlined:
    'bg-transparent text-on-surface border border-border-strong',
  elevated:
    'bg-surface-elevated text-on-surface shadow-[0_1px_2px_rgba(var(--shadow-rgb),0.18),0_2px_10px_rgba(var(--shadow-rgb),0.12)]',
}

export const Md3Card = forwardRef<HTMLDivElement, Md3CardProps>(
  function Md3Card(
    { variant = 'filled', interactive, className = '', ...rest },
    ref
  ) {
    const base = VARIANTS[variant] ?? VARIANTS.filled
    const hover = interactive
      ? 'transition-[transform,box-shadow] duration-150 ease-out hover:scale-[1.005] hover:shadow-[0_4px_14px_rgba(var(--shadow-rgb),0.22)] active:scale-[0.995]'
      : ''
    return (
      <div
        ref={ref}
        {...rest}
        className={`${BASE} ${base} ${hover} ${className}`.trim()}
      />
    )
  }
)
