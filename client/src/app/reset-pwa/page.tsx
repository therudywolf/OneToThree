'use client'

import { useEffect, useState } from 'react'

/**
 * Rescue route for PWAs stuck on a stale Service Worker — primarily users who
 * loaded an old build that cached `/api/auth/me` and now sit in a permanent
 * "not logged in" state. Visiting `/reset-pwa` unregisters every SW for this
 * origin, deletes every cached entry, drops Workbox/Next caches, and offers a
 * one-click jump back to `/`.
 *
 * No auth required. No data is touched in IndexedDB / localStorage so vault
 * blobs survive — this is strictly the network/cache layer.
 */
export default function ResetPwaPage() {
  const [status, setStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const [log, setLog] = useState<string[]>([])

  useEffect(() => {
    if (typeof window === 'undefined') return
    void run()
  }, [])

  async function run() {
    setStatus('working')
    const out: string[] = []
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        out.push(`unregister: ${regs.length} service worker(s)`)
        await Promise.all(regs.map((r) => r.unregister().catch(() => false)))
      } else {
        out.push('no Service Worker API in this browser')
      }
      if (typeof caches !== 'undefined') {
        const names = await caches.keys()
        out.push(`delete: ${names.length} cache bucket(s)`)
        await Promise.all(names.map((n) => caches.delete(n).catch(() => false)))
      }
      setStatus('done')
    } catch (err) {
      out.push(`error: ${err instanceof Error ? err.message : String(err)}`)
      setStatus('error')
    }
    setLog(out)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 p-6 font-mono text-sm">
      <h1 className="text-base font-semibold uppercase tracking-widest">PWA reset</h1>
      <p className="text-text-muted">
        Removes the Service Worker and HTTP caches for this origin. Vault and
        local data stay intact.
      </p>
      <div className="w-full whitespace-pre-line border border-border-strong/40 bg-void/40 p-3 text-[12px]">
        {status === 'idle' ? 'starting…' : status}
        {log.length > 0 ? `\n\n${log.join('\n')}` : ''}
      </div>
      <div className="flex w-full gap-2">
        <button
          type="button"
          onClick={() => { window.location.href = '/' }}
          className="flex-1 border border-border-strong/60 bg-void/60 px-3 py-2 text-[12px] uppercase tracking-widest hover:bg-void/80"
        >
          Back to app
        </button>
        <button
          type="button"
          onClick={() => { window.location.reload() }}
          className="flex-1 border border-border-strong/60 bg-void/60 px-3 py-2 text-[12px] uppercase tracking-widest hover:bg-void/80"
        >
          Reload
        </button>
      </div>
    </main>
  )
}
