export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024
export const MAX_FILE_SIZE_LABEL = '25MB'
export const MEDIA_TOO_LARGE_CODE = 'MEDIA_TOO_LARGE :: MAX_25MB'

/** Shown when getUserMedia fails or the browser has no secure media API. */
export const MEDIA_ACCESS_ERROR_MESSAGE =
  'Microphone/Camera access denied. HTTPS is required, or permissions were blocked.'

/** DOMException NotAllowedError / SecurityError from getUserMedia (often iOS Safari). */
export const MEDIA_PERMISSION_DENIED_CODE = 'MEDIA_PERMISSION_DENIED'

export function isMediaTooLarge(size: number): boolean {
  return size > MAX_FILE_SIZE_BYTES
}

export function isMediaPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as DOMException).name
  return name === 'NotAllowedError' || name === 'SecurityError'
}

