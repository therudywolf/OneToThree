/**
 * PROJECT 13 :: GATEWAY_PROBE_PROTOCOL
 * Level: Edge Layer (Middleware)
 * Vibe: Clinical Pure / Terminal Noir
 */

import { NextResponse, type NextRequest } from 'next/server'
import { normalizeApiRoot } from '@/lib/api/url'
// Single source of truth, shared with auth-provider.tsx and use-401-handler.ts —
// those two gates each used to keep their own shorter copy of this list.
import { isAuthScreen, isPublicRoute } from '@/lib/public-routes'

const SESSION_COOKIE = 'fm_session'
// `/.well-known/` MUST bypass the auth gate: Android App Links + Apple
// universal-links verifiers fetch `/.well-known/assetlinks.json` (et al.)
// unauthenticated, and a redirect to /login fails verification (the file is
// `.json`, which the static-asset regex below deliberately does not match).
const BYPASS_PREFIXES = ['/_next/', '/api/', '/workbox-', '/.well-known/']
// wasm + tflite: the MediaPipe camera-effects runtime (/mediapipe-wasm/*,
// /models/*.tflite) is fetched by the page like any other static asset — a
// 307→/login here silently breaks background blur.
const STATIC_ASSETS_RE = /\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|txt|xml|wasm|tflite)$/i

/** [PROBE_BYPASS] :: Фильтрация системного шума */
function isBypassPath(pathname: string): boolean {
  // /offline.html must bypass the auth gate: the service worker precaches it at
  // install time, and a 307→/login would cache the LOGIN page under the offline
  // fallback key (issue #10).
  if (pathname === '/favicon.ico' || pathname === '/icon.png' || pathname === '/manifest.webmanifest' || pathname === '/sw.js' || pathname === '/offline.html') return true
  if (BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  return STATIC_ASSETS_RE.test(pathname)
}

function resolveApiBase(request: NextRequest): string {
  // This runs SERVER-SIDE (Next middleware), so reach the API over the INTERNAL
  // URL when set (e.g. http://api:8080 inside Docker) — the public
  // NEXT_PUBLIC_API_URL may not be routable from inside the web container, which
  // would make every session probe fail and bounce authed users back to /login.
  // Fall back to the public URL, then same-origin.
  const internal = process.env.API_INTERNAL_URL?.trim()
  const fromEnv = internal || process.env.NEXT_PUBLIC_API_URL?.trim()
  return normalizeApiRoot(fromEnv, { sameOriginFallback: `${request.nextUrl.origin}/api` })
}

/** [AUTH_SCAN] :: Верификация сессии через API шлюз */
type SessionLock = 'authed' | 'unauthed' | 'unknown'

async function verifySessionLock(request: NextRequest): Promise<SessionLock> {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return 'unauthed'

  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return 'unauthed'

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 800)

  try {
    const res = await fetch(`${resolveApiBase(request)}/auth/me`, {
      method: 'GET',
      headers: { cookie: cookieHeader },
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    if (res.ok) return 'authed'
    // Only an explicit auth rejection means logged-out; a 5xx is inconclusive.
    if (res.status === 401 || res.status === 403) return 'unauthed'
    return 'unknown'
  } catch (error) {
    clearTimeout(timeoutId)
    // Network error / 800ms timeout: INCONCLUSIVE — do NOT log the user out.
    console.warn(`>> [SYS.GATEWAY] AUTH_SCAN_INCONCLUSIVE: ${error instanceof Error ? error.message : 'TIMEOUT'}`)
    return 'unknown'
  }
}

/**
 * [PROXY_LOGIC] :: Главный диспетчер трафика.
 * Next.js 16 требует именованный экспорт "proxy" или "default".
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (isBypassPath(pathname)) {
    return NextResponse.next()
  }

  // RSC soft-navigations / prefetches: skip the blocking auth probe (it added up
  // to 800ms per in-app navigation) and never redirect them — the client owns
  // auth for these, and bouncing an RSC request to /login corrupts the router
  // cache. Let them through untouched (issue #10).
  const isRsc =
    request.headers.get('rsc') === '1' ||
    request.headers.has('next-router-prefetch') ||
    request.nextUrl.searchParams.has('_rsc')
  if (isRsc) {
    return NextResponse.next()
  }

  const isPublic = isPublicRoute(pathname)

  // Skip the auth probe for public paths — saves a round-trip per
  // request and keeps /legal/* reachable without DB / API access.
  const lock: SessionLock = isPublic ? 'unauthed' : await verifySessionLock(request)
  const isAuthed = lock === 'authed'

  let response = NextResponse.next()

  // Redirect to /login ONLY when the session is DEFINITIVELY invalid. On an
  // inconclusive probe (API slow/unreachable) fail open so a valid session is
  // never bounced to /login by a transient timeout (issue #10).
  if (!isPublic && lock === 'unauthed') {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search = pathname === '/' ? '' : `?next=${encodeURIComponent(`${pathname}${search}`)}`
    response = NextResponse.redirect(loginUrl)
  } else if (isAuthed && isAuthScreen(pathname)) {
    // Symmetric: someone already signed in has no business on either auth
    // screen, so /register sends them home too. Deliberately narrower than
    // `isPublicRoute` — a signed-in user may legitimately read /legal/* or run
    // /reset-pwa, and must not be bounced home from them.
    const homeUrl = request.nextUrl.clone()
    homeUrl.pathname = '/'
    homeUrl.search = ''
    response = NextResponse.redirect(homeUrl)
  }

  // [HARD_CLINIC] :: Security Headers
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-XSS-Protection', '1; mode=block')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')

  return response
}

/** [DEFAULT_EXPORT] :: Для совместимости с мидлваром */
export default proxy

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
}
