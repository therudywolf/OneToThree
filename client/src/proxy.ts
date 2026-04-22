/**
 * PROJECT 13 :: GATEWAY_PROBE_PROTOCOL
 * Level: Edge Layer (Middleware)
 * Vibe: Clinical Pure / Terminal Noir
 */

import { NextResponse, type NextRequest } from 'next/server'

const SESSION_COOKIE = 'fm_session'
const PUBLIC_PATHS = new Set<string>(['/login'])
const BYPASS_PREFIXES = ['/_next/', '/api/', '/workbox-']
const STATIC_ASSETS_RE = /\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|txt|xml)$/i

/** [PROBE_BYPASS] :: Фильтрация системного шума */
function isBypassPath(pathname: string): boolean {
  if (pathname === '/favicon.ico' || pathname === '/icon.png' || pathname === '/manifest.webmanifest' || pathname === '/sw.js') return true
  if (BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  return STATIC_ASSETS_RE.test(pathname)
}

function resolveApiBase(request: NextRequest): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL?.trim()
  if (fromEnv) return `${fromEnv.replace(/\/$/, '')}/api`
  return `${request.nextUrl.origin}/api`
}

/** [AUTH_SCAN] :: Верификация сессии через API шлюз */
async function verifySessionLock(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return false

  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return false

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
    return res.ok
  } catch (error) {
    clearTimeout(timeoutId)
    console.warn(`>> [SYS.GATEWAY] AUTH_SCAN_ABORTED: ${error instanceof Error ? error.message : 'TIMEOUT'}`)
    return false
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

  const isAuthed = await verifySessionLock(request)
  const isPublic = PUBLIC_PATHS.has(pathname)

  let response = NextResponse.next()

  // Маршрутизация по состоянию доступа
  if (!isAuthed && !isPublic) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search = pathname === '/' ? '' : `?next=${encodeURIComponent(`${pathname}${search}`)}`
    response = NextResponse.redirect(loginUrl)
  } else if (isAuthed && pathname === '/login') {
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