import { NextResponse, type NextRequest } from 'next/server'

const SESSION_COOKIE = 'fm_session'
const PUBLIC_PATHS = new Set<string>(['/login'])

const BYPASS_PREFIXES = ['/_next/', '/api/', '/workbox-']
const STATIC_ASSETS_RE = /\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|txt|xml)$/i

// Быстрый фильтр системных путей
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

async function verifySessionLock(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return false

  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return false

  // SYS.TIMEOUT: Не ждем ответа от API дольше 800мс на уровне Edge
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
    // Глушим ошибку таймаута или сбоя сети, но логируем в консоль сервера
    const msg = error instanceof Error ? error.message : String(error)
    console.warn(`[GATEWAY_WARN] Session verification failed/aborted: ${msg}`)
    return false
  }
}

export async function middleware(request: NextRequest) {
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

  // Внедрение жесткой клиники (Security Headers)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-XSS-Protection', '1; mode=block')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
}