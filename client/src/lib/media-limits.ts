/**
 * PROJECT 13 :: MEDIA_LIMITS_PROTOCOL
 * Level: Connection Layer (Data Constraints)
 * Vibe: Clinical Pure / Terminal Noir
 */

// Расширяем канал до 100MB. Больше — риск для стабильности JS-потока при шифровании.
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024 
export const MAX_FILE_SIZE_LABEL = '100MB'
export const MEDIA_TOO_LARGE_CODE = 'MEDIA_TOO_LARGE :: MAX_100MB'

/** Выводится при отказе сенсоров или отсутствии HTTPS-линка. */
export const MEDIA_ACCESS_ERROR_MESSAGE =
  'SENSORS_OFFLINE. Microphone/Camera access denied. HTTPS required or policy block.'

/** DOMException NotAllowedError / SecurityError (типично для WebKit/Safari). */
export const MEDIA_PERMISSION_DENIED_CODE = 'MEDIA_PERMISSION_DENIED'

/** [VALIDATE_SIZE] :: Проверка сегмента на вхождение в лимит */
export function isMediaTooLarge(size: number): boolean {
  return size > MAX_FILE_SIZE_BYTES
}

/** [VALIDATE_AUTH] :: Проверка прав на использование аппаратных ресурсов */
export function isMediaPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as DOMException).name
  return name === 'NotAllowedError' || name === 'SecurityError'
}