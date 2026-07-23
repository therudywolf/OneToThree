'use client'

import { useEffect } from 'react'

/**
 * Eagerly registers the PWA service worker on app start (production only),
 * independent of the push opt-in.
 *
 * next-pwa's `register: true` injects its registration snippet into the
 * Pages-Router `main.js` webpack entry, which the App Router never loads — so
 * without this the service worker only registered as a side effect of a user
 * enabling notifications. For everyone else the PWA never installed: no
 * beforeinstallprompt, no offline fallback, no app-shell precache, no
 * background sync. Registering here fixes "PWA broke & doesn't work" (issue #10).
 *
 * The SW file (`/sw.js`) is emitted by next-pwa only in production builds
 * (`disable` in development), so this is a no-op in dev.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    let cancelled = false
    const register = () => {
      if (cancelled) return
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch((err) => {
          if (!cancelled) console.warn('[pwa] service worker registration failed', err)
        })
    }

    // Register after load so it never competes with first paint / hydration.
    if (document.readyState === 'complete') {
      register()
    } else {
      window.addEventListener('load', register, { once: true })
    }
    return () => {
      cancelled = true
      window.removeEventListener('load', register)
    }
  }, [])

  return null
}
