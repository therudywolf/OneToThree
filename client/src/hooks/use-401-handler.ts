import { useRef, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'

export function shouldHandleUnauthorized(
  status: number,
  pathname: string,
  requestUrl: string,
  hasRedirected: boolean
): boolean {
  if (status !== 401 || hasRedirected) return false
  const isAuthRoute = pathname === '/login' || pathname === '/auth/qr'
  if (isAuthRoute) return false
  const normalizedUrl = requestUrl.toLowerCase()
  const isAuthBootstrapRequest =
    normalizedUrl.includes('/api/auth/me') ||
    normalizedUrl.includes('/api/auth/logout')
  return !isAuthBootstrapRequest
}

/**
 * The pristine `window.fetch`, captured once at module load — before the
 * interceptor below can wrap it. Capturing inside the hook with `useRef`
 * was unsafe: on a remount it would capture the already-overridden fetch
 * as the "original", nesting wrappers unboundedly.
 */
const pristineFetch =
  typeof window !== 'undefined' ? window.fetch.bind(window) : null

/**
 * Hook to intercept and handle 401 Unauthorized errors globally.
 *
 * Usage:
 * - Call once in a high-level component (e.g., AuthProvider or layout)
 * - Automatically redirects to login on 401 and clears auth state
 * - Prevents "auth loops" by tracking redirect state
 */
export function use401Handler() {
  const router = useRouter()
  const pathname = usePathname()
  const { logout } = useAuth()
  const hasRedirectedRef = useRef(false)

  // The interceptor is installed once (empty deps); these refs feed it the
  // current pathname/logout/router without reinstalling it on every
  // navigation.
  const pathnameRef = useRef(pathname)
  const logoutRef = useRef(logout)
  const routerRef = useRef(router)
  pathnameRef.current = pathname
  logoutRef.current = logout
  routerRef.current = router

  useEffect(() => {
    if (typeof window === 'undefined' || !pristineFetch) return

    window.fetch = async (
      ...args: Parameters<typeof fetch>
    ): Promise<Response> => {
      const requestUrl =
        typeof args[0] === 'string'
          ? args[0]
          : args[0] instanceof Request
            ? args[0].url
            : String(args[0])
      const response = await pristineFetch(...args)

      if (
        shouldHandleUnauthorized(
          response.status,
          pathnameRef.current,
          requestUrl,
          hasRedirectedRef.current
        )
      ) {
        hasRedirectedRef.current = true
        console.warn('[auth] 401 Unauthorized — clearing session and redirecting to login')

        try {
          await logoutRef.current()
        } catch (e) {
          console.error('[auth] Logout call failed', e)
        }

        setTimeout(() => {
          routerRef.current.push('/login')
        }, 100)

        return response
      }

      // Reset redirect guard if we see a successful response
      if (response.status === 200 || response.status === 201) {
        hasRedirectedRef.current = false
      }

      return response
    }

    return () => {
      window.fetch = pristineFetch
    }
  }, [])
}
