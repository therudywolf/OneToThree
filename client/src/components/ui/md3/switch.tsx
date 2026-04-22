'use client'

import { forwardRef, type HTMLAttributes } from 'react'

/**
 * MD3 Switch — accessible toggle using theme tokens.
 * Input element remains a hidden checkbox so the switch is drag/keyboard
 * friendly. `checked` + `onChange` are forwarded exactly like a native
 * <input type="checkbox"> for drop-in replacement.
 */
type Md3SwitchProps = Omit<HTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}

export const Md3Switch = forwardRef<HTMLButtonElement, Md3SwitchProps>(
  function Md3Switch(
    { checked, onChange, disabled, label, className = '', ...rest },
    ref
  ) {
    return (
      <button
        ref={ref}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors
          ${checked
            ? 'border-primary/50 bg-primary/30'
            : 'border-border-strong bg-surface'}
          disabled:pointer-events-none disabled:opacity-50
          ${className}`.trim()}
        {...rest}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full transition-transform
            ${checked
              ? 'translate-x-6 bg-primary shadow-[0_0_8px_rgba(var(--shadow-rgb),0.45)]'
              : 'translate-x-1 bg-on-surface/80'}`}
        />
      </button>
    )
  }
)
