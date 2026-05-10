'use client'

import {
  forceReleaseBodyScrollLocks,
  hasActiveBodyScrollLocks,
} from '@/lib/body-scroll-lock'

/**
 * PROJECT 13 :: OPTICAL_SHROUD_CLEANUP
 * Level: Interface Layer (DOM Cleanup)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * Purpose: Ensures node root is sterile after overlay termination.
 */

/** [PURGE_OVERFLOW] :: Аннигиляция блокировок скролла */
export function purgeInterfaceOverflow(): void {
  if (typeof document === 'undefined') return
  
  forceReleaseBodyScrollLocks()
  document.documentElement.style.overflow = ''
}

/** * [MONITOR_STRAY_PORTALS] 
 * Проверка на наличие «забытых» диалоговых окон в DOM. 
 * Если радар чист — сбрасываем блокировки интерфейса.
 */
export function monitorStrayPortals(): void {
  if (typeof document === 'undefined') return

  /** [NEXT_CYCLE_SYNC] :: Ожидание следующего кадра для синхронизации слоев */
  requestAnimationFrame(() => {
    // Ищем любые активные шлюзы (диалоги)
    const activePortals = document.querySelectorAll('[role="dialog"]')
    
    if (activePortals.length === 0 && !hasActiveBodyScrollLocks()) {
      purgeInterfaceOverflow()
    }
  })
}

export const ensureBackdropCleanup = monitorStrayPortals
