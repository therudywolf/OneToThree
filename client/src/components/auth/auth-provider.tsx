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
import { AuthHttpError, fetchMe, logoutApi } from '@/lib/api/auth'
import { wipeAllClientLocalState } from '@/lib/client-wipe'

/** `is_discoverable` is synced from PATCH /users/me and GET /users/me/settings (optional). */
export type AuthUser = {
  id: string
  username: string
  is_discoverable?: boolean
  role?: 'user' | 'admin'
  totp_enabled?: boolean
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
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  /** Only the latest `refresh()` may update state (avoids race: initial /me after login sets cookie). */
  const refreshGeneration = useRef(0)

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
    } catch (e) {
      if (myId !== refreshGeneration.current) return
      if (e instanceof AuthHttpError) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[auth] refresh failed', e.status)
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
  }, [])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    refreshGeneration.current++
    await logoutApi()
    setUser(null)
    setLoading(false)
  }, [])

  const updateUser = useCallback((patch: Partial<AuthUser>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : null))
  }, [])

  const value = useMemo(
    () => ({ user, loading, refresh, logout, updateUser }),
    [user, loading, refresh, logout, updateUser]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
