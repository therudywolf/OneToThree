/**
 * E2EE metadata for attachments: encrypted in message `content` / `iv`.
 * Binary on object storage is encrypted with a per-file AES-GCM key wrapped by the chat AES key.
 */

export const ATTACHMENT_MARKER = 'attachment' as const

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
    }
  } catch {
    return null
  }
}
