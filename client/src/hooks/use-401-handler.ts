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

  // Store the original fetch function
  const originalFetch = useRef(typeof window !== 'undefined' ? window.fetch : null)

  useEffect(() => {
    if (typeof window === 'undefined' || !originalFetch.current) return

    // Override the global fetch to intercept responses
    window.fetch = async (
      ...args: Parameters<typeof fetch>
    ): Promise<Response> => {
      const requestUrl =
        typeof args[0] === 'string'
          ? args[0]
          : args[0] instanceof Request
            ? args[0].url
            : String(args[0])
      const response = await originalFetch.current!.apply(window, args)

      // Handle 401 Unauthorized
      if (shouldHandleUnauthorized(response.status, pathname, requestUrl, hasRedirectedRef.current)) {
        hasRedirectedRef.current = true
        console.warn('[auth] 401 Unauthorized — clearing session and redirecting to login')

        try {
          // Clear auth state
          await logout()
        } catch (e) {
          console.error('[auth] Logout call failed', e)
        }

        // Redirect to login with a small delay to ensure state is cleared
        setTimeout(() => {
          router.push('/login')
        }, 100)

        // Return the response without consuming it further
        return response
      }

      // Reset redirect guard if we see a successful response
      if (response.status === 200 || response.status === 201) {
        hasRedirectedRef.current = false
      }

      return response
    }

    // Restore original fetch on cleanup
    return () => {
      if (originalFetch.current) {
        window.fetch = originalFetch.current
      }
    }
  }, [logout, pathname, router])
}
