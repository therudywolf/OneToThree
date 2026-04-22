'use client'

import { use401Handler } from '@/hooks/use-401-handler'
import type { ReactNode } from 'react'

/**
 * PROJECT 13 :: AUTH_401_GATEKEEPER
 * Level: Sentinel Layer (Zero-Trust)
 * Purpose: Immediate link severance upon signal expiration (401_Warden)
 */

export function Auth401Interceptor({ children }: { children: ReactNode }) {
  /**
   * Активация ловушки для неавторизованных запросов.
   * Если узел теряет доверие (401), хук инициирует немедленную изоляцию (Auth Wipe).
   */
  use401Handler()

  return <>{children}</>
}