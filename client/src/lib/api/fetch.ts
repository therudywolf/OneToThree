import { getNativeToken, isNativeApp } from '@/lib/native-session'
import { normalizeApiRoot } from '@/lib/api/url'

const DEFAULT_TIMEOUT_MS = 15_000

/** Configured API root: an absolute origin for native apps, '/api' (same-origin) for web. */
const API_ROOT = normalizeApiRoot(
  typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL?.trim() : undefined
)

/**
 * True only when `input` targets the API origin. The native Bearer token (a full
 * session JWT) must NEVER be attached to a non-API origin — e.g. presigned
 * MinIO/S3 URLs (s3.onetothree.ru) for avatars, or giphy/tenor — or it leaks the
 * session credential to that host's access logs, a fronting proxy, or a
 * compromised endpoint. The httpOnly cookie path is host-scoped and never had
 * this exposure; the Bearer fallback must replicate that origin scoping.
 */
export function targetsApiOrigin(input: RequestInfo | URL): boolean {
  try {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const pageOrigin = typeof location !== 'undefined' ? location.origin : undefined
    if (API_ROOT.startsWith('/')) {
      // Same-origin API (web): the API lives on the page origin.
      if (!pageOrigin) return false
      return new URL(url, pageOrigin).origin === pageOrigin
    }
    const apiOrigin = new URL(API_ROOT).origin
    return new URL(url, apiOrigin).origin === apiOrigin
  } catch {
    return false
  }
}

/**
 * fetch() with an AbortSignal timeout so requests don't hang indefinitely.
 * Accepts the same arguments as fetch(); timeout defaults to 15 s.
 */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, cache, ...rest } = init ?? {}

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let timedOut: ReturnType<typeof setTimeout> | undefined

  // If the caller supplied their own signal, abort when either fires.
  if (callerSignal) {
    callerSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // Native WebViews (Capacitor/Tauri) can't reliably persist the cross-site
  // session cookie, so flag every request as native (the server then returns the
  // JWT in login response bodies) and replay the stored token as a Bearer header.
  const headers = new Headers(rest.headers as HeadersInit | undefined)
  if (isNativeApp() && targetsApiOrigin(input)) {
    headers.set('X-Native-Client', '1')
    const tok = getNativeToken()
    if (tok && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${tok}`)
  }

  // Authenticated session traffic must NEVER be served from the HTTP or
  // Service-Worker cache — a stale `/auth/me` 401 would persist past a fresh
  // login. Callers can opt back in to caching by passing an explicit
  // `cache:` value (e.g. `'force-cache'` for static media manifests).
  const request = fetch(input, {
    ...rest,
    headers,
    cache: cache ?? 'no-store',
    signal: controller.signal,
  })

  // The abort above is not enough inside the APK. capacitor.config.json enables
  // CapacitorHttp, whose patched fetch routes anything that is not
  // GET/HEAD/OPTIONS/TRACE through the native bridge — and the bridge ignores
  // AbortSignal entirely. Every POST, PUT and DELETE therefore had no timeout
  // at all: a request that never came back left the caller waiting forever,
  // with a spinner and no error.
  //
  // Racing a timer gives the caller the same rejection it would have got from
  // the abort. The native request may still be in flight; its result is
  // discarded, which is exactly what an abort would have delivered anyway.
  const deadline = new Promise<never>((_, reject) => {
    timedOut = setTimeout(() => {
      reject(new DOMException(`Request timed out after ${timeoutMs} ms`, 'TimeoutError'))
    }, timeoutMs)
  })

  return Promise.race([request, deadline]).finally(() => {
    clearTimeout(timer)
    if (timedOut) clearTimeout(timedOut)
  }) as Promise<Response>
}
