/**
 * PROJECT 13 :: HAPTIC_SIGNAL_EMITTER
 * Level: Hardware Layer (Tactile Feedback)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/**
 * [EMIT_HAPTIC_PULSE]
 * Генерирует короткий тактильный отклик (вибрацию).
 * Игнорируется, если узел не поддерживает API или активен режим экономии движения.
 */
export function emitHapticPulse(pattern: number | number[] = 20): void {
  // [1] ENVIRONMENT_CHECK :: Проверка наличия аппаратного драйвера
  if (typeof navigator === 'undefined' || !navigator.vibrate) return

  try {
    // [2] ACCESSIBILITY_CHECK :: Уважение к системным настройкам (Reduced Motion)
    const isMotionReduced = typeof window !== 'undefined' && 
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    if (isMotionReduced) return

    // [3] SIGNAL_DISPATCH :: Подача импульса на корпус узла
    navigator.vibrate(pattern)
  } catch (err) {
    // Сбой драйвера или блокировка политики безопасности — игнорируем
  }
}

export const vibrateShort = emitHapticPulse