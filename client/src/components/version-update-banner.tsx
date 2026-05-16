'use client'

import { useEffect, useState } from 'react'
import {
  startVersionCheck,
  type VersionChangeDetail,
} from '@/lib/version-check'

/**
 * Non-intrusive banner that appears when the server announces a version
 * different from the one this tab loaded with. One reload clears it.
 *
 * Reload bypasses every cache layer we control:
 *   - service worker (unregister before reload)
 *   - http cache (location.reload doesn't reuse bf-cache)
 *
 * Dismiss is local-only; the next poll re-shows it if a newer version
 * is still live. That's intentional — out-of-date clients fail in subtle
 * ways and we want users nudged.
 */
export function VersionUpdateBanner() {
  const [pending, setPending] = useState<VersionChangeDetail | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    startVersionCheck()
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<VersionChangeDetail>).detail
      if (!detail) return
      setPending(detail)
      setDismissed(false)
    }
    window.addEventListener('p13:version-changed', handler)
    return () => window.removeEventListener('p13:version-changed', handler)
  }, [])

  if (!pending || dismissed) return null

  const onReload = async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister().catch(() => false)))
      }
      if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)))
      }
    } catch {
      /* best-effort */
    }
    window.location.reload()
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-3 z-[200] mx-auto w-fit max-w-[calc(100%-1.5rem)] rounded-md border border-neon-cyan/40 bg-[color:var(--surface)]/95 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-text-primary shadow-lg backdrop-blur"
    >
      <span className="text-text-muted">build {pending.client} → </span>
      <span className="text-neon-cyan">{pending.server}</span>
      <button
        type="button"
        onClick={onReload}
        className="ml-3 rounded border border-neon-cyan/60 px-2 py-0.5 hover:border-neon-cyan hover:text-neon-cyan"
      >
        reload
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="dismiss"
        className="ml-1 px-1 text-text-muted/60 hover:text-text-muted"
      >
        ×
      </button>
    </div>
  )
}
