'use client'

/**
 * Guarded bridge to the Android CallForegroundService (CallServicePlugin).
 *
 * No-op on web and iOS — the plugin only exists in the Android Capacitor build.
 * Starting a microphone-typed foreground service for the duration of a call keeps
 * the mic + peer audio alive when the app is backgrounded (issue #3/#13: on
 * Android 12+ a backgrounded WebView call without such a service loses mic access).
 */
type CallServicePlugin = {
  start: () => Promise<{ ok: boolean }>
  stop: () => Promise<{ ok: boolean }>
}

function getPlugin(): CallServicePlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as {
    Capacitor?: { Plugins?: Record<string, unknown> }
  }).Capacitor
  const plugin = cap?.Plugins?.CallService as CallServicePlugin | undefined
  return plugin ?? null
}

export function startCallForegroundService(): void {
  const p = getPlugin()
  if (p) void p.start().catch(() => { /* best-effort */ })
}

export function stopCallForegroundService(): void {
  const p = getPlugin()
  if (p) void p.stop().catch(() => { /* best-effort */ })
}
