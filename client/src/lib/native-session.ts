'use client'

const SESSION_COOKIE = 'fm_session'

type CapacitorCookieBridge = {
  getCookies: (options: { url: string }) => Promise<unknown>
  deleteCookie: (options: { url: string; key: string }) => Promise<unknown>
  clearCookies: (options: { url: string }) => Promise<unknown>
}

type WindowWithCapacitor = typeof window & {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: {
      CapacitorCookies?: Partial<CapacitorCookieBridge>
    }
  }
}

type GlobalWithCapacitorCookies = typeof globalThis & {
  CapacitorCookies?: Partial<CapacitorCookieBridge>
}

function isHttpOrigin(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

export function isNativeCapacitorPlatform(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(
    (window as WindowWithCapacitor).Capacitor?.isNativePlatform?.()
  )
}

function getNativeCookieBridge(): CapacitorCookieBridge | null {
  if (typeof window === 'undefined') return null

  const runtimeBridge = (window as WindowWithCapacitor).Capacitor?.Plugins?.CapacitorCookies
  if (
    runtimeBridge?.getCookies &&
    runtimeBridge.deleteCookie &&
    runtimeBridge.clearCookies
  ) {
    return runtimeBridge as CapacitorCookieBridge
  }

  const globalBridge = (globalThis as GlobalWithCapacitorCookies).CapacitorCookies
  if (
    globalBridge?.getCookies &&
    globalBridge.deleteCookie &&
    globalBridge.clearCookies
  ) {
    return globalBridge as CapacitorCookieBridge
  }

  return null
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

  const cookieBridge = getNativeCookieBridge()
  if (!cookieBridge) return

  const origins = resolveNativeSessionOrigins()
  if (origins.length === 0) return

  await Promise.allSettled(
    origins.map(async (url) => {
      await cookieBridge.getCookies({ url })
    })
  )
}

export async function clearNativeSessionCookie(): Promise<void> {
  if (!isNativeCapacitorPlatform()) return

  const cookieBridge = getNativeCookieBridge()
  if (!cookieBridge) return

  const origins = resolveNativeSessionOrigins()
  if (origins.length === 0) return

  await Promise.allSettled(
    origins.map(async (url) => {
      try {
        await cookieBridge.deleteCookie({ url, key: SESSION_COOKIE })
      } catch {
        await cookieBridge.clearCookies({ url })
      }
    })
  )
}
