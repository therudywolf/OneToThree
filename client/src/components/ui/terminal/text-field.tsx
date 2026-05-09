'use client'

import { forwardRef, type InputHTMLAttributes, useId } from 'react'

type TerminalTextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  supportText?: string
  error?: string
}

export const TerminalTextField = forwardRef<HTMLInputElement, TerminalTextFieldProps>(
  function TerminalTextField({ id, label, supportText, error, className = '', ...rest }, ref) {
    const auto = useId()
    const inputId = id ?? `terminal-tf-${auto}`
    const hasError = Boolean(error)
    return (
      <div className="w-full">
        <label
          htmlFor={inputId}
          className={`mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] ${
            hasError ? 'text-neon-red' : 'text-text-muted'
          }`}
        >
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          className={`block min-h-10 w-full rounded-none border bg-void px-3 py-2 font-mono text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-muted/50 focus:border-neon-cyan ${
            hasError ? 'border-neon-red' : 'border-border-strong'
          } ${className}`.trim()}
          {...rest}
        />
        {(supportText || error) && (
          <p className={`mt-1 font-mono text-[10px] ${hasError ? 'text-neon-red' : 'text-text-muted'}`}>
            {error ?? supportText}
          </p>
        )}
      </div>
    )
  }
)
