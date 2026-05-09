/**
 * Sprint M1-3 — server-side per-category size enforcement.
 * Mirrors client/src/lib/media-limits.ts (keep in sync).
 */

export type MediaCategory = 'image' | 'video' | 'audio' | 'gif' | 'file'

export const MEDIA_SIZE_LIMITS: Record<MediaCategory, number> = {
  image: 25 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  gif: 25 * 1024 * 1024,
  file: 100 * 1024 * 1024,
}

export const MAX_UPLOAD_BYTES = MEDIA_SIZE_LIMITS.video // ceiling across categories

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function categorizeMime(mime: string): MediaCategory {
  const lower = (mime || '').toLowerCase().split(';')[0].trim()
  if (lower === 'image/gif') return 'gif'
  if (lower.startsWith('image/')) return 'image'
  if (lower.startsWith('video/')) return 'video'
  if (lower.startsWith('audio/')) return 'audio'
  return 'file'
}

/** Resolve the effective per-category cap (env override → constant default). */
export function categoryLimitBytes(category: MediaCategory): number {
  switch (category) {
    case 'image':
      return envInt('MEDIA_LIMIT_IMAGE_BYTES', MEDIA_SIZE_LIMITS.image)
    case 'video':
      return envInt('MEDIA_LIMIT_VIDEO_BYTES', MEDIA_SIZE_LIMITS.video)
    case 'audio':
      return envInt('MEDIA_LIMIT_AUDIO_BYTES', MEDIA_SIZE_LIMITS.audio)
    case 'gif':
      return envInt('MEDIA_LIMIT_GIF_BYTES', MEDIA_SIZE_LIMITS.gif)
    case 'file':
      return envInt('MEDIA_LIMIT_FILE_BYTES', MEDIA_SIZE_LIMITS.file)
  }
}

/** Effective ceiling — max across all enabled categories. */
export function effectiveMaxUploadBytes(): number {
  return Math.max(
    categoryLimitBytes('image'),
    categoryLimitBytes('video'),
    categoryLimitBytes('audio'),
    categoryLimitBytes('gif'),
    categoryLimitBytes('file')
  )
}
