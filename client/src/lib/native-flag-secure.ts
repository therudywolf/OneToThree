'use client'

/**
 * Native FLAG_SECURE bridge.
 *
 * On Android, `FLAG_SECURE` set on the Activity window blocks screenshots
 * and prevents the app surface from appearing in the recent-apps thumbnail.
 * Capacitor doesn't ship this in core; we expect a plugin named `Privacy`
 * exposing `setSecure({ secure: boolean })`. If absent (web, iOS, plugin
 * not installed) the call is a no-op — surface contract:
 *
 *   await setNativeFlagSecure(true)   // best-effort enable
 *   await setNativeFlagSecure(false)  // best-effort disable
 *
 * iOS has no equivalent OS API. The closest is overlaying the app surface
 * on `applicationWillResignActive`, which is implemented in JavaScript via
 * the `blankOnBlur` flag in `chat-privacy.ts`.
 */

type CapacitorWindow = typeof window & {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: Record<string, unknown>
  }
}

type PrivacyPlugin = {
  setSecure?: (options: { secure: boolean }) => Promise<unknown>
}

function getPrivacyPlugin(): PrivacyPlugin | null {
  if (typeof window === 'undefined') return null
  const w = window as CapacitorWindow
  if (!w.Capacitor?.isNativePlatform?.()) return null
  const plugin = w.Capacitor?.Plugins?.Privacy as PrivacyPlugin | undefined
  if (!plugin || typeof plugin.setSecure !== 'function') return null
  return plugin
}

export async function setNativeFlagSecure(secure: boolean): Promise<void> {
  const plugin = getPrivacyPlugin()
  if (!plugin?.setSecure) return
  try {
    await plugin.setSecure({ secure })
  } catch {
    /* plugin call failed — non-fatal */
  }
}
