/**
 * E2EE metadata for attachments: encrypted in message `content` / `iv`.
 * Binary on object storage is encrypted with a per-file AES-GCM key wrapped by the chat AES key.
 */

export const ATTACHMENT_MARKER = 'attachment' as const
export const ALBUM_MARKER = 'album' as const
export const STICKER_MARKER = 'sticker' as const

/**
 * Explicit rendering hint. Optional for backward compatibility with clients that
 * pre-date v1.1: legacy messages fall back to MIME / filename heuristics.
 */
export type AttachmentKind =
  | 'voice'
  | 'video_circle'
  | 'video'
  | 'image'
  | 'file'

export type AttachmentEnvelopeV1 = {
  p13: typeof ATTACHMENT_MARKER
  v: 1
  fileName: string
  fileSize: number
  mimeType: string
  /** IV for {@link encryptBinary} wrapping the raw file key. */
  wrapIv: string
  /** Base64 ciphertext of the 32-byte raw AES-GCM file key. */
  wrapCt: string
  /** Optional user-provided caption shown below the media bubble. */
  caption?: string
  /**
   * Explicit kind hint introduced in v1.1.
   * If absent, renderers fall back to MIME / filename heuristics.
   */
  kind?: AttachmentKind
}

export type AlbumItemV1 = {
  path: string
  iv: string
  mimeType: string
  fileName: string
  fileSize: number
  /** Base64 wrapped per-file AES key (blank for PUBLIC mode). */
  wrapCt: string
  wrapIv: string
  kind: AttachmentKind
  /** Optional dominant-color-based thumbhash for quick placeholder. */
  thumbhash?: string
}

export type AlbumEnvelopeV1 = {
  p13: typeof ALBUM_MARKER
  v: 1
  items: AlbumItemV1[]
  caption?: string
}

export type StickerEnvelopeV1 = {
  p13: typeof STICKER_MARKER
  v: 1
  packId: string
  stickerId: string
  /** Format: tgs (gzip lottie), lottie, webp, webm. */
  format: 'tgs' | 'lottie' | 'webp' | 'webm'
  /** CDN path to the sticker asset (public/read-only). */
  path: string
  fallbackEmoji?: string
  width?: number
  height?: number
}

function isAttachmentKind(v: unknown): v is AttachmentKind {
  return (
    v === 'voice' ||
    v === 'video_circle' ||
    v === 'video' ||
    v === 'image' ||
    v === 'file'
  )
}

export function parseAttachmentEnvelope(
  plaintext: string | null | undefined
): AttachmentEnvelopeV1 | null {
  if (!plaintext || plaintext === '[DECRYPT_FAIL]') return null
  const t = plaintext.trim()
  if (!t.startsWith('{')) return null
  try {
    const o = JSON.parse(t) as Partial<AttachmentEnvelopeV1>
    if (o.p13 !== ATTACHMENT_MARKER || o.v !== 1) return null
    if (
      typeof o.fileName !== 'string' ||
      typeof o.fileSize !== 'number' ||
      typeof o.mimeType !== 'string' ||
      typeof o.wrapIv !== 'string' ||
      typeof o.wrapCt !== 'string'
    ) {
      return null
    }
    const kind = isAttachmentKind(o.kind) ? o.kind : undefined
    return {
      p13: ATTACHMENT_MARKER,
      v: 1,
      fileName: o.fileName.slice(0, 512),
      fileSize: o.fileSize,
      mimeType: o.mimeType.slice(0, 256),
      wrapIv: o.wrapIv,
      wrapCt: o.wrapCt,
      ...(typeof o.caption === 'string' && o.caption.trim()
        ? { caption: o.caption.slice(0, 512) }
        : {}),
      ...(kind ? { kind } : {}),
    }
  } catch {
    return null
  }
}

export function parseAlbumEnvelope(
  plaintext: string | null | undefined
): AlbumEnvelopeV1 | null {
  if (!plaintext || plaintext === '[DECRYPT_FAIL]') return null
  const t = plaintext.trim()
  if (!t.startsWith('{')) return null
  try {
    const o = JSON.parse(t) as Partial<AlbumEnvelopeV1>
    if (o.p13 !== ALBUM_MARKER || o.v !== 1) return null
    if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > 10) return null
    const items: AlbumItemV1[] = []
    for (const raw of o.items) {
      if (!raw || typeof raw !== 'object') return null
      const r = raw as Partial<AlbumItemV1>
      if (
        typeof r.path !== 'string' ||
        typeof r.iv !== 'string' ||
        typeof r.mimeType !== 'string' ||
        typeof r.fileName !== 'string' ||
        typeof r.fileSize !== 'number' ||
        typeof r.wrapCt !== 'string' ||
        typeof r.wrapIv !== 'string' ||
        !isAttachmentKind(r.kind)
      ) {
        return null
      }
      items.push({
        path: r.path.slice(0, 2048),
        iv: r.iv,
        mimeType: r.mimeType.slice(0, 256),
        fileName: r.fileName.slice(0, 512),
        fileSize: r.fileSize,
        wrapCt: r.wrapCt,
        wrapIv: r.wrapIv,
        kind: r.kind,
        ...(typeof r.thumbhash === 'string' ? { thumbhash: r.thumbhash.slice(0, 512) } : {}),
      })
    }
    return {
      p13: ALBUM_MARKER,
      v: 1,
      items,
      ...(typeof o.caption === 'string' && o.caption.trim()
        ? { caption: o.caption.slice(0, 512) }
        : {}),
    }
  } catch {
    return null
  }
}

export function parseStickerEnvelope(
  plaintext: string | null | undefined
): StickerEnvelopeV1 | null {
  if (!plaintext || plaintext === '[DECRYPT_FAIL]') return null
  const t = plaintext.trim()
  if (!t.startsWith('{')) return null
  try {
    const o = JSON.parse(t) as Partial<StickerEnvelopeV1>
    if (o.p13 !== STICKER_MARKER || o.v !== 1) return null
    if (
      typeof o.packId !== 'string' ||
      typeof o.stickerId !== 'string' ||
      typeof o.path !== 'string'
    ) {
      return null
    }
    const format = o.format
    if (format !== 'tgs' && format !== 'lottie' && format !== 'webp' && format !== 'webm') {
      return null
    }
    return {
      p13: STICKER_MARKER,
      v: 1,
      packId: o.packId.slice(0, 128),
      stickerId: o.stickerId.slice(0, 128),
      format,
      path: o.path.slice(0, 2048),
      ...(typeof o.fallbackEmoji === 'string' ? { fallbackEmoji: o.fallbackEmoji.slice(0, 16) } : {}),
      ...(typeof o.width === 'number' ? { width: o.width } : {}),
      ...(typeof o.height === 'number' ? { height: o.height } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Classify an attachment based on envelope + MIME + filename.
 * Preference order: explicit `envelope.kind` > MIME > filename heuristic.
 */
export function classifyAttachment(opts: {
  envelope?: AttachmentEnvelopeV1 | null
  mediaType?: string | null
  mimeType?: string | null
  fileName?: string | null
}): AttachmentKind {
  const { envelope, mediaType, mimeType, fileName } = opts
  if (envelope?.kind) return envelope.kind
  const mime = (mimeType ?? envelope?.mimeType ?? '').toLowerCase()
  const name = (fileName ?? envelope?.fileName ?? '').toLowerCase()
  if (mime.startsWith('audio/')) return 'voice'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) {
    // Legacy heuristic: "video-circle-*" / voicenote-style from old clients.
    if (/^video-(note|circle)-/i.test(name)) return 'video_circle'
    return 'video'
  }
  if (mediaType === 'audio') return 'voice'
  if (mediaType === 'image') return 'image'
  if (mediaType === 'video') return 'video'
  return 'file'
}
