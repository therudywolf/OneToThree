'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'

/**
 * MD3 Button — three variants backed by theme tokens only.
 *
 * - `filled`   — primary action: solid `primary` background + contrast text.
 * - `tonal`    — secondary action: tinted background, primary-colored text.
 * - `text`     — tertiary action: no background, underlined on hover.
 *
 * Shape comes from the shell (`--border-radius`).
 * Typography and radii switch automatically when `data-shell="md3"`.
 */
export type Md3ButtonVariant = 'filled' | 'tonal' | 'text'

type Md3ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Md3ButtonVariant
  block?: boolean
}

const BASE_STYLES =
  'relative inline-flex min-h-10 items-center justify-center gap-2 px-4 py-2 font-theme text-sm font-medium tracking-wide transition-[background,color,border-color,transform,box-shadow] duration-150 ease-out ' +
  'rounded-[var(--radius-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void ' +
  'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50'

const VARIANT_STYLES: Record<Md3ButtonVariant, string> = {
  filled:
    'bg-primary text-on-surface shadow-[0_1px_3px_rgba(var(--shadow-rgb),0.18)] ' +
    'hover:shadow-[0_2px_8px_rgba(var(--shadow-rgb),0.28)] hover:brightness-[1.05] ' +
    'active:brightness-95',
  tonal:
    'bg-primary/15 text-primary hover:bg-primary/25 active:bg-primary/30',
  text:
    'bg-transparent text-primary hover:bg-primary/10 active:bg-primary/15',
}

export const Md3Button = forwardRef<HTMLButtonElement, Md3ButtonProps>(
  function Md3Button(
    { variant = 'filled', block, className = '', ...rest },
    ref
  ) {
    const style = VARIANT_STYLES[variant] ?? VARIANT_STYLES.filled
    return (
      <button
        ref={ref}
        {...rest}
        className={`${BASE_STYLES} ${style} ${block ? 'w-full' : ''} ${className}`.trim()}
      />
    )
  }
)
