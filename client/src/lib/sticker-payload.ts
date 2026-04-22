import { STICKER_MARKER, type StickerEnvelopeV1 } from '@/lib/attachment-envelope'
import type { Sticker, StickerFormat } from '@/lib/api/stickers'

function formatToEnvelope(f: StickerFormat): StickerEnvelopeV1['format'] {
  if (f === 'static') return 'webp'
  return f
}

/** JSON plaintext for `sendText` / E2E payload (stable S3 key in `path`, not presigned URL). */
export function buildStickerPlaintext(
  sticker: Sticker,
  packId: string,
  packFormat: StickerFormat
): string {
  const env: StickerEnvelopeV1 = {
    p13: STICKER_MARKER,
    v: 1,
    packId,
    stickerId: sticker.id,
    format: formatToEnvelope(packFormat),
    path: sticker.mediaKey,
    ...(sticker.emoji?.trim() ? { fallbackEmoji: sticker.emoji.slice(0, 16) } : {}),
    ...(typeof sticker.width === 'number' && sticker.width > 0 ? { width: sticker.width } : {}),
    ...(typeof sticker.height === 'number' && sticker.height > 0 ? { height: sticker.height } : {}),
  }
  return JSON.stringify(env)
}
