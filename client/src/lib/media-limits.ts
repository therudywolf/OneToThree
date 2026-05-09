/**
 * Sprint M1-3 — per-category media limits (Telegram/Discord parity).
 *
 * Categorizes uploads by MIME prefix and enforces a size ceiling per
 * category, plus dimension/duration caps for image and video. The server
 * mirrors these caps in `server/src/lib/media-limits.ts`; keep them in sync.
 */

export type MediaCategory = 'image' | 'video' | 'audio' | 'gif' | 'file'

/** Hard ceiling kept for legacy callers — equals the file/blob fallback cap. */
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024
export const MAX_FILE_SIZE_LABEL = '100MB'
export const MEDIA_TOO_LARGE_CODE = 'MEDIA_TOO_LARGE :: MAX_100MB'

export const MEDIA_ACCESS_ERROR_MESSAGE =
  'SENSORS_OFFLINE. Microphone/Camera access denied. HTTPS required or policy block.'

export const MEDIA_PERMISSION_DENIED_CODE = 'MEDIA_PERMISSION_DENIED'

/** Per-category byte ceilings. Mirrored on server. */
export const MEDIA_SIZE_LIMITS: Record<MediaCategory, number> = {
  image: 25 * 1024 * 1024,        // 25 MiB — covers high-res photos
  video: 500 * 1024 * 1024,       // 500 MiB — TG-style large video uploads
  audio: 50 * 1024 * 1024,        // 50 MiB — long-form voice notes / music
  gif: 25 * 1024 * 1024,          // 25 MiB — animated images
  file: 100 * 1024 * 1024,        // 100 MiB — generic documents
}

/** Image dimension ceiling — guards against decompression bombs / gigapixel uploads. */
export const MAX_IMAGE_DIMENSION = 12_000

/** Video duration ceiling in seconds (default 30 minutes). */
export const MAX_VIDEO_DURATION_SECS = 30 * 60

export function categorizeMime(mime: string): MediaCategory {
  const lower = (mime || '').toLowerCase().split(';')[0].trim()
  if (lower === 'image/gif') return 'gif'
  if (lower.startsWith('image/')) return 'image'
  if (lower.startsWith('video/')) return 'video'
  if (lower.startsWith('audio/')) return 'audio'
  return 'file'
}

export function categoryLimitBytes(category: MediaCategory): number {
  return MEDIA_SIZE_LIMITS[category]
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

/** Legacy size check — kept for callers that don't know the MIME yet. */
export function isMediaTooLarge(size: number): boolean {
  return size > MAX_FILE_SIZE_BYTES
}

export type MediaLimitError =
  | { kind: 'size'; category: MediaCategory; sizeBytes: number; limitBytes: number }
  | { kind: 'image_dimension'; width: number; height: number; limit: number }
  | { kind: 'video_duration'; durationSecs: number; limit: number }
  | { kind: 'image_decode' }
  | { kind: 'video_probe' }

export function validateSize(
  sizeBytes: number,
  category: MediaCategory
): MediaLimitError | null {
  const limit = categoryLimitBytes(category)
  if (sizeBytes > limit) {
    return { kind: 'size', category, sizeBytes, limitBytes: limit }
  }
  return null
}

/** Validate an image File/Blob against MAX_IMAGE_DIMENSION. */
export async function validateImageDimensions(
  file: Blob
): Promise<MediaLimitError | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    bitmap.close?.()
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      return {
        kind: 'image_dimension',
        width,
        height,
        limit: MAX_IMAGE_DIMENSION,
      }
    }
    return null
  } catch {
    return { kind: 'image_decode' }
  }
}

/** Validate a video File/Blob against MAX_VIDEO_DURATION_SECS. */
export async function validateVideoDuration(
  file: Blob
): Promise<MediaLimitError | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    const cleanup = () => {
      URL.revokeObjectURL(url)
      video.src = ''
    }
    video.onloadedmetadata = () => {
      const duration = video.duration
      cleanup()
      if (!Number.isFinite(duration) || duration <= 0) {
        resolve({ kind: 'video_probe' })
        return
      }
      if (duration > MAX_VIDEO_DURATION_SECS) {
        resolve({
          kind: 'video_duration',
          durationSecs: duration,
          limit: MAX_VIDEO_DURATION_SECS,
        })
        return
      }
      resolve(null)
    }
    video.onerror = () => {
      cleanup()
      resolve({ kind: 'video_probe' })
    }
    video.src = url
  })
}

/** Run all applicable checks for a single file before queueing for upload. */
export async function validateFileForUpload(
  file: File
): Promise<MediaLimitError | null> {
  const category = categorizeMime(file.type)
  const sizeErr = validateSize(file.size, category)
  if (sizeErr) return sizeErr
  if (category === 'image' || category === 'gif') {
    const dimErr = await validateImageDimensions(file)
    if (dimErr) return dimErr
  } else if (category === 'video') {
    const durErr = await validateVideoDuration(file)
    if (durErr) return durErr
  }
  return null
}

export function describeLimitError(err: MediaLimitError): string {
  switch (err.kind) {
    case 'size':
      return `Файл слишком большой (${formatBytes(err.sizeBytes)}). Лимит для ${err.category}: ${formatBytes(err.limitBytes)}.`
    case 'image_dimension':
      return `Изображение ${err.width}×${err.height} превышает лимит ${err.limit}px по стороне.`
    case 'video_duration':
      return `Видео длиной ${Math.round(err.durationSecs)}с превышает лимит ${Math.round(err.limit / 60)} мин.`
    case 'image_decode':
      return 'Не удалось прочитать изображение — файл повреждён или формат не поддерживается.'
    case 'video_probe':
      return 'Не удалось прочитать длительность видео — файл повреждён или формат не поддерживается.'
  }
}

export function isMediaPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as DOMException).name
  return name === 'NotAllowedError' || name === 'SecurityError'
}
