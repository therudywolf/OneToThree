'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { attachNativeListener } from '@/lib/native-listener'

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
  // The injected bridge returns a plain `{ remove }`, the npm package a Promise
  // of one — see attachNativeListener.
  addListener: (
    eventName: 'appUrlOpen',
    listenerFunc: (data: { url?: string }) => void
  ) => { remove: () => unknown } | Promise<{ remove: () => unknown }>
  getLaunchUrl?: () => Promise<{ url?: string } | null | undefined>
}

type CapacitorWindow = typeof window & {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: { App?: CapacitorAppPlugin }
  }
}

/**
 * The only `/join/*` document the static export contains.
 *
 * `generateStaticParams()` in app/join/[code]/page.tsx emits exactly one param
 * (`_`), so `out/join/_` is the single join page shipped inside the APK. The
 * invite code therefore has to travel as `?code=`, which is what
 * JoinPackClient reads first — routing to `/join/<code>` finds no document in
 * the WebView and lands the user on a 404 instead of the invite screen.
 */
const JOIN_ROUTE = '/join/_'

const joinPath = (code: string) => `${JOIN_ROUTE}?code=${encodeURIComponent(code)}`

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

    // https App Link: /join/<code> — and /join/?code=<code>, which is what the
    // server-side share links use.
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      const match = /^\/join\/([^/]+)\/?$/.exec(u.pathname)
      if (match) {
        const code = decodeURIComponent(match[1]).trim()
        if (code && code !== '_') return joinPath(code)
      }
      if (/^\/join\/?$/.test(u.pathname)) {
        const code = u.searchParams.get('code')?.trim()
        if (code) return joinPath(code)
      }
      return null
    }

    // Custom scheme: onetothree://chat?chat=<id> or onetothree://join/<code>
    if (u.protocol === 'onetothree:') {
      const code = u.searchParams.get('code')?.trim()
      if (code) return joinPath(code)
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
    void attachNativeListener(() => app.addListener('appUrlOpen', (data) => route(data?.url))).then(
      (detach) => {
        if (cancelled) {
          detach?.()
          return
        }
        remove = detach
      }
    )

    return () => {
      cancelled = true
      remove?.()
    }
  }, [router])

  return null
}
