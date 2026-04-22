'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'

/**
 * MD3 Chip — small, pill-shaped control used for filters, selections, tags.
 * Token-backed, supports `selected` toggle, `disabled`, and an optional
 * trailing close icon.
 */
type Md3ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean
  leading?: React.ReactNode
  trailing?: React.ReactNode
}

export const Md3Chip = forwardRef<HTMLButtonElement, Md3ChipProps>(
  function Md3Chip(
    { selected, leading, trailing, className = '', children, ...rest },
    ref
  ) {
    const base =
      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-theme text-xs transition-colors ' +
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60'
    const toneSelected =
      'border-transparent bg-primary/15 text-primary hover:bg-primary/25'
    const toneIdle =
      'border-border-strong text-text-muted hover:border-primary/60 hover:text-text-primary'
    return (
      <button
        ref={ref}
        type="button"
        aria-pressed={selected}
        {...rest}
        className={`${base} ${selected ? toneSelected : toneIdle} ${className}`.trim()}
      >
        {leading}
        <span>{children}</span>
        {trailing}
      </button>
    )
  }
)
