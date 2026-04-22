'use client'

import { forwardRef, type HTMLAttributes, type ElementType, type ReactNode } from 'react'
import { useShell } from './use-shell'

type Variant =
  | 'title'        // Big headings — tracked caps in terminal, medium weight sans in MD3
  | 'label'        // UI labels / section captions
  | 'meta'         // Timestamps, sender names, chat meta
  | 'mono'         // Explicit monospace (IDs, hashes) — stays mono even in MD3
  | 'body'         // Plain reading text

type Props = HTMLAttributes<HTMLElement> & {
  variant?: Variant
  as?: ElementType
  children: ReactNode
}

/**
 * Shell-aware typography primitive. Stops chat components from hardcoding
 * `font-mono uppercase tracking-widest` which don't translate to MD3.
 */
export const ShellText = forwardRef<HTMLElement, Props>(function ShellText(
  { variant = 'body', as, className = '', children, ...rest },
  ref
) {
  const { isTerminal } = useShell()

  const As: ElementType =
    as ?? (variant === 'title' ? 'h2' : variant === 'label' ? 'span' : 'span')

  const terminalClasses: Record<Variant, string> = {
    title: 'font-mono text-base font-semibold uppercase tracking-[0.35em] text-neon-cyan',
    label: 'font-mono text-[10px] uppercase tracking-[0.25em] text-neon-cyan/80',
    meta: 'font-mono text-[10px] uppercase tracking-widest text-neon-cyan/70',
    mono: 'font-mono text-xs tracking-wider',
    body: 'font-mono text-sm leading-relaxed',
  }
  const md3Classes: Record<Variant, string> = {
    title: 'text-xl font-medium tracking-[-0.01em] text-[var(--on-surface)]',
    label: 'text-xs font-medium tracking-[0.02em] text-[color-mix(in_srgb,var(--on-surface)_70%,transparent)]',
    meta: 'text-[11px] font-normal tracking-normal text-[color-mix(in_srgb,var(--on-surface)_60%,transparent)]',
    mono: 'font-mono text-xs tracking-normal text-[color-mix(in_srgb,var(--on-surface)_75%,transparent)]',
    body: 'text-[15px] leading-relaxed text-[var(--on-surface)]',
  }

  const cls = (isTerminal ? terminalClasses : md3Classes)[variant]

  return (
    <As ref={ref as never} className={`${cls} ${className}`.trim()} {...rest}>
      {children}
    </As>
  )
})
