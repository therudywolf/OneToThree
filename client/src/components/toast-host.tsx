'use client'

import { useEffect } from 'react'
import { useToastStore } from '@/store/toastStore'

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  useEffect(() => {
    // Allow Escape to clear the most recent toast.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && toasts.length) dismiss(toasts[toasts.length - 1].id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toasts, dismiss])

  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-3 z-[120] flex w-[min(calc(100vw-1rem),420px)] -translate-x-1/2 flex-col gap-1.5"
    >
      {toasts.map((t) => {
        const cls =
          t.level === 'error'
            ? 'border-[var(--danger,theme(colors.red.500))] text-[var(--danger,theme(colors.red.200))]'
            : t.level === 'warn'
            ? 'border-[var(--warning,theme(colors.amber.500))] text-[var(--warning,theme(colors.amber.200))]'
            : t.level === 'success'
            ? 'border-[var(--success,theme(colors.emerald.500))] text-[var(--success,theme(colors.emerald.200))]'
            : 'border-[var(--accent,theme(colors.cyan.400))] text-[var(--accent,theme(colors.cyan.200))]'
        const levelPrefix =
          t.level === 'error'
            ? '[ ! ]'
            : t.level === 'warn'
            ? '[ SYS ]'
            : t.level === 'success'
            ? '[ OK ]'
            : '[ INFO ]'
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto w-full border bg-[var(--surface,rgba(0,0,0,0.92))] px-3 py-2 text-left font-mono text-[12px] leading-tight shadow-[0_6px_20px_rgba(0,0,0,0.35)] ${cls} p13-surface`}
          >
            <div className="mb-0.5 text-[10px] uppercase tracking-[0.2em] opacity-80">{levelPrefix} {t.title ?? 'SYSTEM'}</div>
            <div className="break-words">{t.message}</div>
          </button>
        )
      })}
    </div>
  )
}
