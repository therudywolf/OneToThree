'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Global recovery handler for:
 * 1. ChunkLoadError (script load failures after network/VPN changes)
 * 2. Hydration Guard (if app stays loading >8s on non-auth pages, show Force Reset)
 *
 * FIX: watchdog is suppressed on /login and / (auth pages) to avoid
 * false-positive "App is not responding" when a new user gets 401 and
 * is redirected — the redirect itself takes >5s in some slow connections.
 */
export function RecoveryHandler() {
  const [showForceReset, setShowForceReset] = useState(false)
  const chunkErrorHandledRef = useRef(false)
  const hydrationTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pathname = usePathname()

  // Auth-related paths where watchdog must NOT fire
  const isAuthPage =
    pathname === '/login' ||
    pathname === '/' ||
    pathname?.startsWith('/login') ||
    pathname?.startsWith('/join')

  useEffect(() => {
    const handleChunkError = (error: Event) => {
      const event = error as ErrorEvent
      if (
        event.message?.includes('ChunkLoadError') ||
        event.message?.includes('Failed to fetch') ||
        event.message?.includes('dynamically imported module')
      ) {
        if (!chunkErrorHandledRef.current) {
          chunkErrorHandledRef.current = true
          if (!sessionStorage.getItem('chunk_reload_triggered')) {
            sessionStorage.setItem('chunk_reload_triggered', 'true')
            console.warn('[recovery] ChunkLoadError detected, reloading once...')
            window.location.reload()
          } else {
            console.warn('[recovery] ChunkLoadError detected, reload already attempted; skipping loop')
          }
        }
      }
    }

    const handleAppReady = () => {
      if (hydrationTimeoutRef.current) {
        clearTimeout(hydrationTimeoutRef.current)
        hydrationTimeoutRef.current = null
        setShowForceReset(false)
      }
    }

    const handleRejection = (evt: PromiseRejectionEvent) => {
      if (evt.reason?.message?.includes('ChunkLoadError')) {
        handleChunkError(evt.reason)
      }
    }

    window.addEventListener('error', handleChunkError)
    window.addEventListener('unhandledrejection', handleRejection)
    window.addEventListener('app-ready', handleAppReady)

    // Watchdog: only on app pages, not on auth/login routes
    // Also clear watchdog on any user interaction (redirect counts as navigation, not stuck)
    let guardStarted = false
    if (!isAuthPage) {
      guardStarted = true
      hydrationTimeoutRef.current = setTimeout(() => {
        setShowForceReset(true)
        console.warn('[recovery] App appears to be stuck in loading state')
      }, 8000) // increased to 8s to tolerate slow initial loads
    }

    const clearGuard = () => {
      if (hydrationTimeoutRef.current) {
        clearTimeout(hydrationTimeoutRef.current)
        hydrationTimeoutRef.current = null
      }
      // Hide modal if it was shown (e.g. user navigated away)
      setShowForceReset(false)
    }

    window.addEventListener('click', clearGuard, { once: true })
    window.addEventListener('touchstart', clearGuard, { once: true })

    return () => {
      window.removeEventListener('error', handleChunkError)
      window.removeEventListener('unhandledrejection', handleRejection)
      window.removeEventListener('app-ready', handleAppReady)
      window.removeEventListener('click', clearGuard)
      window.removeEventListener('touchstart', clearGuard)
      if (hydrationTimeoutRef.current) {
        clearTimeout(hydrationTimeoutRef.current)
        hydrationTimeoutRef.current = null
      }
    }
  // Re-run when pathname changes so watchdog resets on navigation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthPage])

  // Also imperatively kill the modal whenever we land on an auth page
  useEffect(() => {
    if (isAuthPage) {
      setShowForceReset(false)
      if (hydrationTimeoutRef.current) {
        clearTimeout(hydrationTimeoutRef.current)
        hydrationTimeoutRef.current = null
      }
    }
  }, [isAuthPage])

  const handleForceReset = async () => {
    console.warn('[recovery] User triggered Force Reset')
    try {
      if (navigator.serviceWorker?.controller) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((reg) => reg.unregister()))
      }
      window.location.reload()
    } catch (e) {
      console.error('[recovery] Force Reset error', e)
      window.location.reload()
    }
  }

  if (!showForceReset) return null

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="space-y-4 border border-neon-red bg-black/95 p-6 text-center shadow-[0_0_16px_rgba(255,0,0,0.4)]">
        <p className="font-mono text-sm text-neon-cyan">
          App is not responding
        </p>
        <p className="text-xs text-gray-400">
          The app may have encountered a loading issue. Clear cache and reload?
        </p>
        <button
          type="button"
          onClick={handleForceReset}
          className="border border-neon-red bg-black/50 px-4 py-2 font-mono text-sm text-neon-red hover:bg-neon-red/10"
        >
          FORCE RESET
        </button>
      </div>
    </div>
  )
}
