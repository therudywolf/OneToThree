'use client'

import { forwardRef, type HTMLAttributes } from 'react'

type TerminalSwitchProps = Omit<HTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}

export const TerminalSwitch = forwardRef<HTMLButtonElement, TerminalSwitchProps>(
  function TerminalSwitch({ checked, onChange, disabled, label, className = '', ...rest }, ref) {
    return (
      <button
        ref={ref}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`inline-flex h-6 w-12 shrink-0 items-center border font-mono transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/70 disabled:pointer-events-none disabled:opacity-50 ${
          checked
            ? 'border-neon-cyan bg-neon-cyan/18'
            : 'border-border-strong bg-void'
        } ${className}`.trim()}
        {...rest}
      >
        <span
          className={`mx-1 h-3.5 w-4 border transition-transform ${
            checked
              ? 'translate-x-5 border-neon-cyan bg-neon-cyan shadow-[0_0_8px_color-mix(in_srgb,var(--neon-cyan)_55%,transparent)]'
              : 'translate-x-0 border-text-muted bg-surface-elevated'
          }`}
        />
      </button>
    )
  }
)
