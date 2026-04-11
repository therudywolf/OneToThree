/** Short tactical haptics; no-op when unsupported or reduced-motion. */
export function vibrateShort(pattern: number | number[] = 20): void {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    navigator.vibrate(pattern)
  } catch {
    /* ignore */
  }
}
