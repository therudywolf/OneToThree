'use client'

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { useShell } from './use-shell'

type Size = 'sm' | 'md' | 'lg'
type Tone = 'default' | 'primary' | 'danger' | 'ghost'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: Size
  tone?: Tone
  active?: boolean
  children: ReactNode
}

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
}

/**
 * Square icon button (Terminal) ↔ circular squircle (MD3). Used for composer
 * actions (attach, emoji, mic, send), header gear, dock toggles.
 *
 * `tone` maps to the palette tokens, not specific colors, so a Dracula user
 * still gets their purple primary in MD3 and their neon-cyan accent in
 * Terminal — no hardcoded literal colors here.
 */
export const ShellIconButton = forwardRef<HTMLButtonElement, Props>(
  function ShellIconButton(
    { size = 'md', tone = 'default', active = false, className = '', children, ...rest },
    ref
  ) {
    const { isTerminal } = useShell()

    const base = 'inline-flex shrink-0 items-center justify-center transition-[background-color,color,border-color,box-shadow] duration-150 disabled:opacity-40 disabled:pointer-events-none outline-none focus-visible:ring-2 focus-visible:ring-offset-0'
    const shape = isTerminal
      ? 'rounded-none border'
      : 'rounded-full border-0'

    const toneTerminal: Record<Tone, string> = {
      default: active
        ? 'border-neon-cyan bg-neon-cyan/15 text-neon-cyan shadow-[0_0_10px_color-mix(in_srgb,var(--neon-cyan)_35%,transparent)]'
        : 'border-neon-cyan/40 bg-void text-neon-cyan/85 hover:border-neon-cyan hover:text-neon-cyan hover:shadow-[0_0_8px_color-mix(in_srgb,var(--neon-cyan)_30%,transparent)]',
      primary:
        'border-neon-cyan bg-neon-cyan/20 text-neon-cyan shadow-[0_0_12px_color-mix(in_srgb,var(--neon-cyan)_45%,transparent)] hover:bg-neon-cyan/30',
      danger:
        'border-neon-red/60 bg-neon-red/15 text-neon-red hover:bg-neon-red/25 hover:shadow-[0_0_10px_color-mix(in_srgb,var(--neon-red)_35%,transparent)]',
      ghost:
        'border-transparent text-neon-cyan/70 hover:text-neon-cyan hover:bg-neon-cyan/10',
    }
    const toneMd3: Record<Tone, string> = {
      default: active
        ? 'bg-[color-mix(in_srgb,var(--neon-cyan)_18%,transparent)] text-[var(--neon-cyan)]'
        : 'bg-transparent text-[color-mix(in_srgb,var(--on-surface)_75%,transparent)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]',
      primary:
        'bg-[var(--neon-cyan)] text-[var(--surface)] hover:bg-[color-mix(in_srgb,var(--neon-cyan)_85%,black)] shadow-[0_1px_2px_rgba(0,0,0,0.3),0_2px_6px_rgba(0,0,0,0.15)]',
      danger:
        'bg-[color-mix(in_srgb,var(--neon-red)_12%,transparent)] text-[var(--neon-red)] hover:bg-[color-mix(in_srgb,var(--neon-red)_20%,transparent)]',
      ghost:
        'bg-transparent text-[color-mix(in_srgb,var(--on-surface)_65%,transparent)] hover:bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]',
    }

    const toneClass = isTerminal ? toneTerminal[tone] : toneMd3[tone]

    return (
      <button
        ref={ref}
        className={`${base} ${shape} ${SIZE_CLASSES[size]} ${toneClass} ${className}`.trim()}
        {...rest}
      >
        {children}
      </button>
    )
  }
)
