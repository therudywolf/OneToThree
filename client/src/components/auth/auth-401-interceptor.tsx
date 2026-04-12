'use client'

import { use401Handler } from '@/hooks/use-401-handler'
import type { ReactNode } from 'react'

/**
 * Wrapper component that enables global 401 error handling.
 * Should be placed inside AuthProvider but above all other components.
 */
export function Auth401Interceptor({ children }: { children: ReactNode }) {
  use401Handler()
  return <>{children}</>
}
