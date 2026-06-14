'use client'

import { normalizeHttpOrigin } from '@/lib/api/url'

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

/** True inside ANY native WebView — Capacitor (mobile) or Tauri (desktop). */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false
  if (isNativeCapacitorPlatform()) return true
  const w = window as typeof window & {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
    isTauri?: boolean
  }
  return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__ || w.isTauri)
}

// ── Bearer-token fallback ───────────────────────────────────────────────────
// Native WebViews can't reliably persist the cross-site `fm_session` cookie, so
// after login the server also returns the JWT in the body (gated by the
// X-Native-Client header) and we keep it here, replaying it as a Bearer token
// on every request. Web never stores it (keeps the httpOnly cookie).
const NATIVE_TOKEN_KEY = 'fm_native_token'

export function getNativeToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(NATIVE_TOKEN_KEY)
  } catch {
    return null
  }
}

export function setNativeToken(token: string | null | undefined): void {
  if (typeof window === 'undefined' || !token) return
  try {
    window.localStorage.setItem(NATIVE_TOKEN_KEY, token)
  } catch {
    /* quota / private mode */
  }
}

export function clearNativeToken(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(NATIVE_TOKEN_KEY)
  } catch {
    /* ignore */
  }
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
  const apiOrigin = normalizeHttpOrigin(apiRoot)
  if (apiOrigin) {
    origins.add(apiOrigin)
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
