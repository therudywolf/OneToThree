'use client'

import { CapacitorCookies } from '@capacitor/core'

const SESSION_COOKIE = 'fm_session'

function isHttpOrigin(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

export function isNativeCapacitorPlatform(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(
    (window as typeof window & {
      Capacitor?: { isNativePlatform?: () => boolean }
    }).Capacitor?.isNativePlatform?.()
  )
}

export function resolveNativeSessionOrigins(): string[] {
  if (typeof window === 'undefined') return []

  const origins = new Set<string>()

  const apiRoot =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_API_URL?.trim()
      : undefined
  if (apiRoot && apiRoot !== 'same-origin') {
    try {
      const parsed = new URL(apiRoot)
      if (isHttpOrigin(parsed.origin)) origins.add(parsed.origin)
    } catch {
      // ignore invalid env
    }
  }

  if (window.location?.origin && isHttpOrigin(window.location.origin)) {
    origins.add(window.location.origin)
  }

  return Array.from(origins)
}

export async function warmNativeSessionCookies(): Promise<void> {
  if (!isNativeCapacitorPlatform()) return

  const origins = resolveNativeSessionOrigins()
  if (origins.length === 0) return

  await Promise.allSettled(
    origins.map(async (url) => {
      await CapacitorCookies.getCookies({ url })
    })
  )
}

export async function clearNativeSessionCookie(): Promise<void> {
  if (!isNativeCapacitorPlatform()) return

  const origins = resolveNativeSessionOrigins()
  if (origins.length === 0) return

  await Promise.allSettled(
    origins.map(async (url) => {
      try {
        await CapacitorCookies.deleteCookie({ url, key: SESSION_COOKIE })
      } catch {
        await CapacitorCookies.clearCookies({ url })
      }
    })
  )
}
