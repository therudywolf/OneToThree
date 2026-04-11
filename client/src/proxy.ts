import { NextResponse, type NextRequest } from 'next/server'

const SESSION_COOKIE = 'fm_session'

const PUBLIC_PATHS = new Set<string>(['/login'])

function isBypassPath(pathname: string): boolean {
  if (pathname.startsWith('/_next/')) return true
  if (pathname.startsWith('/api/')) return true
  if (pathname === '/favicon.ico') return true
  if (pathname === '/icon.png') return true
  if (pathname === '/manifest.webmanifest') return true
  if (pathname === '/sw.js') return true
  if (pathname.startsWith('/workbox-')) return true
  return /\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|txt|xml)$/i.test(pathname)
}

function resolveApiBase(request: NextRequest): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL?.trim()
  if (fromEnv) return `${fromEnv.replace(/\/$/, '')}/api`
  // Same-origin API (Next rewrites to Fastify); cookie is on page origin without COOKIE_DOMAIN.
  return `${request.nextUrl.origin}/api`
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return false

  /** Includes `fm_session` when API set `Domain=.parent` (see server `COOKIE_DOMAIN`). */
  const cookieHeader = request.headers.get('cookie') ?? ''
  if (!cookieHeader) return false

  try {
    const res = await fetch(`${resolveApiBase(request)}/auth/me`, {
      method: 'GET',
      headers: {
        cookie: cookieHeader,
      },
      cache: 'no-store',
    })
    return res.ok
  } catch {
    return false
  }
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (isBypassPath(pathname)) {
    return NextResponse.next()
  }

  const isAuthed = await hasValidSession(request)
  const isPublic = PUBLIC_PATHS.has(pathname)

  if (!isAuthed && !isPublic) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search = pathname === '/' ? '' : `?next=${encodeURIComponent(`${pathname}${search}`)}`
    return NextResponse.redirect(loginUrl)
  }

  if (isAuthed && pathname === '/login') {
    const home = request.nextUrl.clone()
    home.pathname = '/'
    home.search = ''
    return NextResponse.redirect(home)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
}

