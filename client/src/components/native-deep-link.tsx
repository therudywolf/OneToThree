'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Native deep-link handler (Android App Links / custom scheme).
 *
 * The Android app registers two `VIEW` intent-filters:
 *   - `https://onetothree.ru/join/...`  (verified App Links)
 *   - `onetothree://chat...`            (custom scheme)
 *
 * Capacitor surfaces the launching/resumed URL via the `App` plugin's
 * `appUrlOpen` event (and `getLaunchUrl()` for a cold start). This component
 * listens for those and routes a `/join/<code>` URL to the in-app join screen
 * so the invite flow runs inside the WebView instead of bouncing to a browser.
 *
 * On web / non-native platforms the `App` plugin is absent and this is a no-op.
 */

type CapacitorAppPlugin = {
  addListener: (
    eventName: 'appUrlOpen',
    listenerFunc: (data: { url?: string }) => void
  ) => Promise<{ remove: () => void }>
  getLaunchUrl?: () => Promise<{ url?: string } | null | undefined>
}

type CapacitorWindow = typeof window & {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: { App?: CapacitorAppPlugin }
  }
}

/**
 * Map an incoming deep-link URL to an in-app path.
 * Returns `null` when the URL is not a recognised deep link.
 *
 * Handles both `https://onetothree.ru/join/<code>` App Links and the
 * `onetothree://chat?...` custom scheme.
 */
export function deepLinkToInAppPath(rawUrl: string): string | null {
  if (!rawUrl) return null
  try {
    const u = new URL(rawUrl)

    // https App Link: /join/<code>
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      const match = /^\/join\/([^/]+)\/?$/.exec(u.pathname)
      if (match) {
        const code = decodeURIComponent(match[1]).trim()
        if (code) return `/join/${encodeURIComponent(code)}`
      }
      return null
    }

    // Custom scheme: onetothree://chat?chat=<id> or onetothree://join/<code>
    if (u.protocol === 'onetothree:') {
      const code = u.searchParams.get('code')?.trim()
      if (code) return `/join/${encodeURIComponent(code)}`
      const chat = u.searchParams.get('chat')?.trim()
      if (chat) return `/?chat=${encodeURIComponent(chat)}`
      return null
    }

    return null
  } catch {
    return null
  }
}

export function NativeDeepLink() {
  const router = useRouter()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as CapacitorWindow
    if (!w.Capacitor?.isNativePlatform?.()) return
    const app = w.Capacitor?.Plugins?.App
    if (!app) return

    let cancelled = false

    const route = (rawUrl: string | undefined) => {
      if (cancelled || !rawUrl) return
      const target = deepLinkToInAppPath(rawUrl)
      if (target) router.push(target)
    }

    // Cold start: the app may have been launched directly by the link.
    void app
      .getLaunchUrl?.()
      .then((res) => route(res?.url))
      .catch(() => {})

    // Warm/foreground: link tapped while the app was already running.
    let remove: (() => void) | null = null
    void app
      .addListener('appUrlOpen', (data) => route(data?.url))
      .then((handle) => {
        if (cancelled) {
          handle.remove()
          return
        }
        remove = () => handle.remove()
      })
      .catch(() => {
        remove = null
      })

    return () => {
      cancelled = true
      remove?.()
    }
  }, [router])

  return null
}
