'use client'

import { forwardRef, type InputHTMLAttributes, useId } from 'react'

/**
 * MD3 Text Field — "outlined" style with floating label.
 * Tokens: --surface, --border-strong, --neon-red (primary), --danger.
 * The label floats when the input is focused or non-empty (via CSS `:placeholder-shown`).
 */
type Md3TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  supportText?: string
  error?: string
}

export const Md3TextField = forwardRef<HTMLInputElement, Md3TextFieldProps>(
  function Md3TextField(
    { id, label, supportText, error, className = '', placeholder = ' ', ...rest },
    ref
  ) {
    const auto = useId()
    const inputId = id ?? `md3-tf-${auto}`
    const hasError = Boolean(error)

    return (
      <div className="w-full">
        <div
          className={`group relative rounded-[var(--radius-md)] border bg-transparent transition-colors
            ${hasError
              ? 'border-danger focus-within:border-danger'
              : 'border-border-strong focus-within:border-primary'}`}
        >
          <input
            ref={ref}
            id={inputId}
            placeholder={placeholder}
            className={`peer block w-full bg-transparent px-3 pt-5 pb-2 font-theme text-sm text-text-primary placeholder-transparent outline-none
              ${className}`.trim()}
            {...rest}
          />
          <label
            htmlFor={inputId}
            className={`pointer-events-none absolute left-3 top-2 origin-left text-[10px] uppercase tracking-[0.25em] transition-all duration-150
              peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:text-xs peer-placeholder-shown:tracking-wider
              peer-focus:top-2 peer-focus:translate-y-0 peer-focus:text-[10px] peer-focus:uppercase peer-focus:tracking-[0.25em]
              ${hasError
                ? 'text-danger'
                : 'text-text-muted peer-focus:text-primary'}`}
          >
            {label}
          </label>
        </div>
        {(supportText || error) && (
          <p
            className={`mt-1 px-1 text-[11px] ${hasError ? 'text-danger' : 'text-text-muted'}`}
          >
            {error ?? supportText}
          </p>
        )}
      </div>
    )
  }
)
