/**
 * Android Chrome/Firefox mobile heuristics (PWA, WebRTC, getDisplayMedia).
 */

/** Typical phone UA: Android + Mobile (tablets often omit "Mobile"). */
export function isAndroidMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /Android/i.test(ua) && /Mobile/i.test(ua)
}
