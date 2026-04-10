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
import { fetchMe, logoutApi } from '@/lib/api/auth'

export type AuthUser = { id: string; username: string }

type AuthContextValue = {
  user: AuthUser | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
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
      setUser(u)
    } catch {
      if (myId !== refreshGeneration.current) return
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

  const value = useMemo(
    () => ({ user, loading, refresh, logout }),
    [user, loading, refresh, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
