/**
 * PROJECT 13 :: NODE_ENVIRONMENT_SCAN
 * Level: OS Layer (Heuristics)
 * Vibe: Clinical Pure / Terminal Noir
 */

/** * [SCAN_ANDROID_SIGNAL] 
 * Типичная сигнатура: Android + Mobile. 
 * Таблетки обычно опускают "Mobile", оставляя только "Android". 
 */
export function isAndroidNode(): boolean {
  if (typeof navigator === 'undefined') return false
  
  const signature = navigator.userAgent
  
  /** * Проверка на вхождение ключевых маркеров. 
   * Использование регулярных выражений для детекции мобильного ядра Android. 
   */
  return /Android/i.test(signature) && /Mobile/i.test(signature)
}

/**
 * [SCAN_PWA_MODE]
 * Проверка, запущен ли узел как автономная оболочка (Standalone).
 */
// --- CONSUMER_ALIASES ---
export const isAndroidMobile = isAndroidNode

export function isStandaloneNode(): boolean {
  if (typeof window === 'undefined') return false
  
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as Record<string, boolean>).standalone ||
    document.referrer.includes('android-app://')
  )
}