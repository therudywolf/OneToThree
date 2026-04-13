'use client'

import { useEffect, useRef } from 'react'
import { useState } from 'react'

/**
 * Global recovery handler for:
 * 1. ChunkLoadError (script load failures after network/VPN changes)
 * 2. Hydration Guard (if app stays loading >5s, show Force Reset button)
 */
export function RecoveryHandler() {
  const [showForceReset, setShowForceReset] = useState(false)
  const chunkErrorHandledRef = useRef(false)
  const hydrationTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    /**
     * Handle ChunkLoadError: If a dynamic import or script fails,
     * trigger a single reload (but not if we already tried once).
     */
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

    /**
     * Hydration Guard: If the app doesn't become interactive within 5s,
     * offer user a Force Reset button to clear Service Worker.
     */
    const startHydrationGuard = () => {
      hydrationTimeoutRef.current = setTimeout(() => {
        // Check if app is still in a loading state
        // (this is a simple heuristic; you can enhance with app state checks)
        setShowForceReset(true)
        console.warn('[recovery] App appears to be stuck in loading state')
      }, 5000)
    }

    /**
     * Clear the hydration guard if the app becomes interactive.
     */
    const handleAppReady = () => {
      if (hydrationTimeoutRef.current) {
        clearTimeout(hydrationTimeoutRef.current)
        hydrationTimeoutRef.current = null
        setShowForceReset(false)
      }
    }

    window.addEventListener('error', handleChunkError)
    window.addEventListener('unhandledrejection', (evt) => {
      if (evt.reason?.message?.includes('ChunkLoadError')) {
        handleChunkError(evt.reason)
      }
    })

    // Start the hydration guard
    startHydrationGuard()

    // Listen for app readiness (you can emit a custom event from your app)
    window.addEventListener('app-ready', handleAppReady)

    // Also clear on user interaction
    const clearGuard = () => {
      if (hydrationTimeoutRef.current) {
        clearTimeout(hydrationTimeoutRef.current)
        hydrationTimeoutRef.current = null
      }
    }
    window.addEventListener('click', clearGuard, { once: true })
    window.addEventListener('touchstart', clearGuard, { once: true })

    return () => {
      window.removeEventListener('error', handleChunkError)
      window.removeEventListener('unhandledrejection', handleChunkError as EventListener)
      window.removeEventListener('app-ready', handleAppReady)
      window.removeEventListener('click', clearGuard)
      window.removeEventListener('touchstart', clearGuard)
      if (hydrationTimeoutRef.current) {
        clearTimeout(hydrationTimeoutRef.current)
      }
    }
  }, [])

  const handleForceReset = async () => {
    console.warn('[recovery] User triggered Force Reset')
    try {
      // Clear Service Worker
      if (navigator.serviceWorker?.controller) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((reg) => reg.unregister()))
      }
      // Clear localStorage if needed (optional, be careful with auth tokens)
      // localStorage.clear()
      // Reload the page
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
