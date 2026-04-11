/**
 * Runtime hints for iOS / iPadOS WebKit quirks (MediaRecorder, getUserMedia, backgrounding).
 */

export function isIOSOrIPadOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
