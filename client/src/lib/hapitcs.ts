/**
 * PROJECT 13 :: HAPTIC_SIGNAL_EMITTER
 * Level: Hardware Layer (Tactile Feedback)
 * Vibe: Clinical Pure / Terminal Noir
 */

export function emitHapticPulse(pattern: number | number[] = 20): void {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return

  try {
    const isMotionReduced = typeof window !== 'undefined' && 
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    if (isMotionReduced) return

    navigator.vibrate(pattern)
  } catch {
    // Silence hardware faults
  }
}