'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { AuthHttpError, fetchMe, logoutApi } from '@/lib/api/auth'
import { wipeAllClientLocalState } from '@/lib/client-wipe'
import { invalidateAvatarCache, clearAllAvatarCache } from '@/lib/avatar-cache'
import { clearNativeSessionCookie, warmNativeSessionCookies } from '@/lib/native-session'
import { clearOwnDrIdentity } from '@/lib/ratchet/session-manager'
import { useSessionStore } from '@/store/sessionStore'
import { isPublicRoute } from '@/lib/public-routes'

/** * `is_discoverable` is synced from PATCH /users/me and GET /users/me/settings (optional).
 * `has_passkeys` indicates if the user has enrolled WebAuthn devices.
 */
export type AuthUser = {
  id: string
  username: string
  is_discoverable?: boolean
  role?: 'user' | 'admin'
  /** Account group/tier — gates admin-panel group management UI. */
  group?: 'creator' | 'admin' | 'premium' | 'regular' | 'test'
  totp_enabled?: boolean
  has_passkeys?: boolean // <-- Флаг для Windows Hello / Face ID
  /** Session-bound device row id (JWT), when present. */
  device_id?: string | null
  avatar_key?: string | null
}

type AuthContextValue = {
  user: AuthUser | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
  /** Merge server-backed fields (e.g. discoverability) without a full session refresh. */
  updateUser: (patch: Partial<AuthUser>) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  /** Only the latest `refresh()` may update state (avoids race: initial /me after login sets cookie). */
  const refreshGeneration = useRef(0)
  const redirectedRef = useRef(false)
  const bootstrappedRef = useRef(false)

  const refresh = useCallback(async () => {
    const myId = ++refreshGeneration.current
    try {
      const { user: u } = await fetchMe()
      if (myId !== refreshGeneration.current) return
      setUser({
        ...u,
        device_id: u.device_id ?? null,
        avatar_key: u.avatar_key ?? null,
      })
      redirectedRef.current = false
    } catch (e) {
      if (myId !== refreshGeneration.current) return
      if (e instanceof AuthHttpError) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[auth] refresh failed', e.status)
        }
        // Handle 401: redirect to login
        // Every PUBLIC route must be excluded, not just /login: a visitor on
        // /register is unauthenticated by definition, so a bare `!== '/login'`
        // check bounced them straight off the sign-up page they had just opened
        // — and the same applied to /legal/* and /reset-pwa, which the edge gate
        // lets through but this one used to redirect away the moment they
        // mounted. Shared list, so the gates cannot drift apart again.
        const onPublicAuthRoute = isPublicRoute(pathname)
        if (
          e.status === 401 &&
          !redirectedRef.current &&
          !onPublicAuthRoute
        ) {
          redirectedRef.current = true
          console.warn('[auth] Session expired (401) — redirecting to login')
          setUser(null)
          setLoading(false)
          // Use a timeout to ensure state updates propagate
          setTimeout(() => {
            router.push('/login?expired=1')
          }, 50)
          return
        }
        if (e.message === 'BANNED_USER') {
          await wipeAllClientLocalState()
        }
      }
      setUser(null)
    } finally {
      if (myId === refreshGeneration.current) {
        setLoading(false)
      }
    }
  }, [pathname, router])

  useEffect(() => {
    if (bootstrappedRef.current) return
    bootstrappedRef.current = true
    // One-shot diagnostic line so a deploy with the wrong NEXT_PUBLIC_API_URL
    // is obvious in the browser console — this is the #1 cause of the
    // "click login, nothing happens" misconfig.
    if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
      try {
        console.debug('[p13:boot]', {
          page: window.location.origin,
          api: process.env.NEXT_PUBLIC_API_URL?.trim() || '(same-origin /api proxy)',
          ws: process.env.NEXT_PUBLIC_WS_ORIGIN?.trim() || '(derived from API_URL)',
        })
      } catch { /* ignore */ }
    }
    setLoading(true)
    void warmNativeSessionCookies().finally(() => refresh())
  }, [refresh])

  const logout = useCallback(async () => {
    refreshGeneration.current++
    redirectedRef.current = true
    await logoutApi()
    await clearNativeSessionCookie()
    // Zeroize in-memory DR identity and session wrap key so chain keys cannot
    // be decrypted from IndexedDB after the session ends.
    clearOwnDrIdentity()
    // ...and the unwrapped vault key itself, which lived on. `setUnwrappedPrivateKey(null)`
    // was reachable only from the manual lock buttons and the idle auto-lock —
    // and auto-lock is mounted INSIDE chat-app, which unmounts on logout, so a
    // session-expiry (401) logout left the previous user's ECDH private key in
    // module state indefinitely. The vault gate in chat-app is a bare
    // `if (!unwrappedPrivateKey)`, not bound to the current user, so anything
    // that reached it without re-activating would have run on the old key.
    // The store is module-level and survives SPA navigation — only a full
    // reload cleared it.
    useSessionStore.getState().reset()
    setUser(null)
    setLoading(false)
    // Clear all cached avatars on logout to prevent memory leaks
    clearAllAvatarCache()
  }, [])

  const updateUser = useCallback((patch: Partial<AuthUser>) => {
    setUser((prev) => {
      if (prev && patch.avatar_key !== undefined && patch.avatar_key !== prev.avatar_key) {
        // Avatar key changed - invalidate cache for this user
        invalidateAvatarCache(prev.id)
      }
      return prev ? { ...prev, ...patch } : null
    })
  }, [])

  const value = useMemo(
    () => ({ user, loading, refresh, logout, updateUser }),
    [user, loading, refresh, logout, updateUser]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
