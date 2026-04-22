/**
 * PROJECT 13 :: APPLE_NODE_DETECTION
 * Level: OS Layer (WebKit Heuristics)
 * Vibe: Clinical Pure / Terminal Noir
 */

/**
 * [SCAN_APPLE_SIGNAL]
 * Проверка на принадлежность к WebKit-экосистеме (iOS / iPadOS).
 * Учитывает iPad на чипах M-серии, которые мимикрируют под macOS (MacIntel).
 */
export function isAppleNode(): boolean {
  if (typeof navigator === 'undefined') return false

  const signature = navigator.userAgent
  const platform = navigator.platform

  // [1] Прямая детекция через UA-строку (iPhone, iPod, старые iPad)
  if (/iPad|iPhone|iPod/.test(signature)) return true

  // [2] Детекция iPadOS (MacIntel + Multi-touch)
  // Начиная с iOS 13, iPad сообщает, что он Mac, но имеет сенсорный ввод.
  return platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/**
 * [SCAN_SAFARI_ENGINE]
 * Проверка, является ли браузер чистым Safari (не Chrome/Firefox на iOS).
 * Важно для специфических багов MediaRecorder.
 */
export function isPureSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  
  const ua = navigator.userAgent
  const isWebkit = /AppleWebKit/i.test(ua)
  const isChrome = /CriOS/i.test(ua)
  const isFirefox = /FxiOS/i.test(ua)

  return isWebkit && !isChrome && !isFirefox
}

export const isIOSOrIPadOS = isAppleNode