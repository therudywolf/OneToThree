'use client'

import imageCompression from 'browser-image-compression'
import { useCallback } from 'react'
import {
  encryptOutboundText,
  getAesKeyForChat,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import {
  arrayBufferToBase64,
  encryptBinary,
  generateAesGcm256Key,
} from '@/lib/crypto'
import type { AttachmentEnvelopeV1, AttachmentKind, AlbumEnvelopeV1, AlbumItemV1 } from '@/lib/attachment-envelope'
import { sendChatMessageOverTransport } from '@/lib/chat-message-transport'
import { decryptApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { cacheMessage } from '@/lib/message-cache'
import { postUploadUrl } from '@/lib/api/storage'
import { isMediaTooLarge, MEDIA_TOO_LARGE_CODE } from '@/lib/media-limits'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import { vibrateShort } from '@/lib/vibrate'
import { explainSendError } from '@/lib/explain-send-error'
import { toastError } from '@/store/toastStore'
import type { DecryptedMessage } from '@/types/chat'

/**
 * PROJECT 13 :: BINARY_TRANSMISSION_PROTOCOL
 * Level: Connection Layer (Data Injection)
 */

/** Maps common MIME types to file extensions for upload validation. */
const MIME_TO_EXT: Record<string, string> = {
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
  'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/aac': '.aac',
  'video/webm': '.webm', 'video/mp4': '.mp4', 'video/ogg': '.ogg',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'application/pdf': '.pdf',
}

const IMAGE_COMPRESSION_THRESHOLD_BYTES = 256 * 1024
const MAX_ALBUM_ITEMS = 10

export type TransmitOptions = {
  label?: string
  mime?: string
  caption?: string
  /**
   * Explicit attachment kind. If omitted, it is inferred from `segmentClass`/MIME.
   */
  kind?: AttachmentKind
}

function ensureExtension(name: string, mime: string): string {
  if (/\.[a-zA-Z0-9]{1,12}$/.test(name)) return name
  const base = mime.split(';')[0].trim().toLowerCase()
  const ext = MIME_TO_EXT[base] ?? (base.startsWith('audio/') ? '.webm' : base.startsWith('video/') ? '.webm' : '.bin')
  return `${name}${ext}`
}

function kindFromSegment(seg: 'audio' | 'video' | 'image' | 'file', mime: string, explicit?: AttachmentKind): AttachmentKind {
  if (explicit) return explicit
  if (seg === 'image') return 'image'
  if (seg === 'audio') return 'voice'
  if (seg === 'video') {
    // Default for generic video is 'video'; callers that record video-circles
    // pass kind: 'video_circle' explicitly.
    return 'video'
  }
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'voice'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

const getSubtle = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) throw new Error('ERR_NO_SUBTLE_CRYPTO')
  return globalThis.crypto.subtle
}

/** PUT payload with retry. */
/**
 * Upload an already-encrypted payload to the presigned PUT URL with retry
 * and — critically — a per-attempt timeout.  Without the AbortSignal the
 * underlying fetch() can sit forever on a stalled connection, which is
 * exactly what "voice send hangs" looks like to the user.  30 s per
 * attempt × 3 attempts gives a hard 90 s ceiling; below that we still
 * surface a real error through the `SEND FAILED` toast.
 */
async function injectWithRetry(
  url: string,
  mime: string,
  payload: ArrayBuffer,
  maxAttempts = 3
): Promise<void> {
  const PER_ATTEMPT_TIMEOUT_MS = 30000
  let attempt = 0
  let lastError: unknown
  while (attempt < maxAttempts) {
    attempt++
    const ac = new AbortController()
    const timeoutId = setTimeout(() => ac.abort(new Error('STORAGE_PUT_TIMEOUT')), PER_ATTEMPT_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: payload,
        signal: ac.signal,
      })
      clearTimeout(timeoutId)
      if (response.ok) return
      const log = await response.text().catch(() => '')
      lastError = new Error(`STORAGE_PUT_${response.status}: ${log.slice(0, 256)}`)
      console.error(`>> [SYS.STORAGE] PUT_FAULT [${response.status}]:`, log.slice(0, 256))
    } catch (err) {
      clearTimeout(timeoutId)
      lastError = err
      console.error('>> [SYS.STORAGE] INJECTION_INTERRUPTED:', err)
    }
    await new Promise((r) => setTimeout(r, 400 * attempt))
  }
  throw lastError instanceof Error ? lastError : new Error('STORAGE_INJECTION_FAILED')
}

type SendContext = {
  activeChatId: string
  userId: string
  unwrappedPrivateKey: CryptoKey
  cryptoCtx: ChatCryptoContext
}

/**
 * Raise a precise error when the caller is missing prerequisites.
 * Previously the hook returned silently, leaving the user with no feedback
 * after holding the record button — classic "voice / circles don't send" bug.
 */
function requireSendContext(ctx: {
  activeChatId: string | null
  userId: string | null
  unwrappedPrivateKey: CryptoKey | null
  cryptoCtx: ChatCryptoContext | null
}): SendContext {
  if (!ctx.activeChatId) throw new Error('SEND_NO_ACTIVE_CHAT')
  if (!ctx.userId) throw new Error('SEND_NO_USER_ID')
  if (!ctx.unwrappedPrivateKey) throw new Error('SEND_VAULT_LOCKED')
  if (!ctx.cryptoCtx) throw new Error('SEND_CRYPTO_NOT_READY')
  return {
    activeChatId: ctx.activeChatId,
    userId: ctx.userId,
    unwrappedPrivateKey: ctx.unwrappedPrivateKey,
    cryptoCtx: ctx.cryptoCtx,
  }
}

type EncryptedBlob = {
  uploadPayload: ArrayBuffer
  mediaIvB64: string
  wrapCt: string
  wrapIv: string
  mimeType: string
  workSize: number
  label: string
}

async function prepareEncryptedBlob(
  rawBlob: Blob,
  segmentClass: 'audio' | 'video' | 'image' | 'file',
  cryptoCtx: ChatCryptoContext,
  unwrappedPrivateKey: CryptoKey,
  options: TransmitOptions
): Promise<EncryptedBlob> {
  const mimeType = options.mime?.trim() || rawBlob.type || 'application/octet-stream'
  const rawLabel = options.label?.trim() || `segment-${Date.now()}`
  const label = ensureExtension(rawLabel, mimeType)

  let workBlob: Blob = rawBlob
  if (segmentClass === 'image' && rawBlob.size > IMAGE_COMPRESSION_THRESHOLD_BYTES) {
    const source = rawBlob instanceof File ? rawBlob : new File([rawBlob], label, { type: mimeType })
    try {
      workBlob = await imageCompression(source, {
        maxWidthOrHeight: 1920,
        useWebWorker: true,
        initialQuality: 0.8,
      })
    } catch {
      workBlob = rawBlob
    }
  }
  if (isMediaTooLarge(workBlob.size)) throw new Error(MEDIA_TOO_LARGE_CODE)

  const isPublicMode = cryptoCtx.mode === 'PUBLIC'

  if (isPublicMode) {
    const uploadPayload = await workBlob.arrayBuffer()
    return {
      uploadPayload,
      mediaIvB64: 'public',
      wrapCt: '',
      wrapIv: '',
      mimeType,
      workSize: workBlob.size,
      label,
    }
  }

  const sectorAesKey = await getAesKeyForChat(unwrappedPrivateKey, cryptoCtx)
  if (!sectorAesKey) throw new Error('ERR_MISSING_SECTOR_KEY')
  const segmentKey = await generateAesGcm256Key()
  const plainData = await workBlob.arrayBuffer()
  const segmentIv = crypto.getRandomValues(new Uint8Array(12))
  const cipherData = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: segmentIv },
    segmentKey,
    plainData
  )
  const rawSegmentKey = await getSubtle().exportKey('raw', segmentKey)
  const { cipher: wrappedKey, ivBase64: wrapIv } = await encryptBinary(
    sectorAesKey,
    rawSegmentKey
  )
  return {
    uploadPayload: cipherData,
    mediaIvB64: arrayBufferToBase64(segmentIv.buffer),
    wrapCt: arrayBufferToBase64(wrappedKey),
    wrapIv,
    mimeType,
    workSize: workBlob.size,
    label,
  }
}

export function useSendMedia(
  cryptoCtx: ChatCryptoContext | null,
  directPeerUserId: string | null
) {
  const activeChatId = useSessionStore(s => s.activeChatId)
  const userId = useSessionStore(s => s.userId)
  const unwrappedPrivateKey = useSessionStore(s => s.unwrappedPrivateKey)
  const appendMessage = useChatStore(s => s.appendMessage)

  const transmitBinary = useCallback(
    async (
      rawBlob: Blob,
      segmentClass: 'audio' | 'video' | 'image' | 'file',
      options?: TransmitOptions
    ) => {
      let ctx: SendContext
      try {
        ctx = requireSendContext({ activeChatId, userId, unwrappedPrivateKey, cryptoCtx })
      } catch (err) {
        toastError(explainSendError(err), { title: 'SEND FAILED' })
        throw err
      }

      try {
        const prepared = await prepareEncryptedBlob(
          rawBlob,
          segmentClass,
          ctx.cryptoCtx,
          ctx.unwrappedPrivateKey,
          options ?? {}
        )
        const kind = kindFromSegment(segmentClass, prepared.mimeType, options?.kind)
        const caption = options?.caption?.trim() || undefined

        const envelope: AttachmentEnvelopeV1 = {
          p13: 'attachment',
          v: 1,
          fileName: prepared.label,
          fileSize: prepared.workSize,
          mimeType: prepared.mimeType,
          wrapIv: prepared.wrapIv,
          wrapCt: prepared.wrapCt,
          kind,
          ...(caption ? { caption } : {}),
        }
        const transportPlaintext = JSON.stringify(envelope)
        const { encrypted_content, iv: envelopeIv } = await encryptOutboundText(
          ctx.unwrappedPrivateKey,
          transportPlaintext,
          ctx.cryptoCtx
        )

        const { uploadUrl, filePath } = await postUploadUrl({
          chatId: ctx.activeChatId,
          fileName: prepared.label,
          fileType: prepared.mimeType,
          fileSize: prepared.workSize,
        })
        await injectWithRetry(uploadUrl, prepared.mimeType, prepared.uploadPayload)

        const { via, serverMessage, outboxId } = await sendChatMessageOverTransport({
          chat_id: ctx.activeChatId,
          transport_mode: ctx.cryptoCtx.mode,
          plaintext: transportPlaintext,
          sender_private_key: ctx.unwrappedPrivateKey,
          my_user_id: ctx.userId,
          peer_user_id: directPeerUserId ?? undefined,
          content: encrypted_content,
          iv: envelopeIv,
          media_path: filePath,
          media_type: segmentClass,
          media_iv: prepared.mediaIvB64,
          media_original_bytes: prepared.workSize,
        })

        if (via === 'REST' && serverMessage) {
          const decrypted = await decryptApiMessageRow(ctx.unwrappedPrivateKey, ctx.cryptoCtx, serverMessage)
          const node =
            (ctx.cryptoCtx.mode === 'DIRECT' || ctx.cryptoCtx.mode === 'SELF') &&
            (decrypted.plaintext === '' || decrypted.plaintext === '[DECRYPT_FAIL]')
              ? { ...decrypted, plaintext: transportPlaintext }
              : decrypted
          void cacheMessage(node).catch(() => {})
          appendMessage(node)
          vibrateShort(20)
          return
        }
        if (via === 'QUEUED' && outboxId) {
          appendMessage({
            id: `pending-${outboxId}`,
            chat_id: ctx.activeChatId,
            sender_id: ctx.userId,
            plaintext: transportPlaintext,
            media_path: filePath,
            media_type: segmentClass,
            media_iv: prepared.mediaIvB64,
            reply_to_id: null,
            read_at: null,
            burn_at: null,
            reactions: {},
            created_at: new Date().toISOString(),
            _pending: true,
          } as DecryptedMessage)
          vibrateShort(10)
        }
      } catch (err) {
        console.error('[SEND_MEDIA] failed', err)
        toastError(explainSendError(err), { title: 'SEND FAILED' })
        throw err
      }
    },
    [activeChatId, userId, unwrappedPrivateKey, directPeerUserId, cryptoCtx, appendMessage]
  )

  /**
   * Send a single outgoing message containing up to 10 media items (photos/videos mixed).
   * Each item is encrypted independently with its own per-file AES key; metadata
   * for every item is wrapped in the `p13: 'album'` envelope sent as one message.
   */
  const transmitAlbum = useCallback(
    async (
      items: Array<{ blob: Blob; segmentClass: 'audio' | 'video' | 'image' | 'file'; options?: TransmitOptions }>,
      caption?: string
    ) => {
      let ctx: SendContext
      try {
        ctx = requireSendContext({ activeChatId, userId, unwrappedPrivateKey, cryptoCtx })
      } catch (err) {
        toastError(explainSendError(err), { title: 'SEND FAILED' })
        throw err
      }

      if (items.length === 0) return
      if (items.length > MAX_ALBUM_ITEMS) {
        toastError(`Albums are limited to ${MAX_ALBUM_ITEMS} items.`, { title: 'ALBUM' })
        throw new Error('ALBUM_TOO_LARGE')
      }
      if (items.length === 1) {
        await transmitBinary(items[0].blob, items[0].segmentClass, {
          ...(items[0].options ?? {}),
          caption,
        })
        return
      }

      try {
        const prepared = await Promise.all(
          items.map((it) =>
            prepareEncryptedBlob(
              it.blob,
              it.segmentClass,
              ctx.cryptoCtx,
              ctx.unwrappedPrivateKey,
              it.options ?? {}
            )
          )
        )

        // Upload all payloads in parallel.
        const uploaded = await Promise.all(
          prepared.map(async (p) => {
            const { uploadUrl, filePath } = await postUploadUrl({
              chatId: ctx.activeChatId,
              fileName: p.label,
              fileType: p.mimeType,
              fileSize: p.workSize,
            })
            await injectWithRetry(uploadUrl, p.mimeType, p.uploadPayload)
            return { ...p, filePath }
          })
        )

        const envelope: AlbumEnvelopeV1 = {
          p13: 'album',
          v: 1,
          items: uploaded.map<AlbumItemV1>((p, i) => ({
            path: p.filePath,
            iv: p.mediaIvB64,
            mimeType: p.mimeType,
            fileName: p.label,
            fileSize: p.workSize,
            wrapCt: p.wrapCt,
            wrapIv: p.wrapIv,
            kind: kindFromSegment(items[i].segmentClass, p.mimeType, items[i].options?.kind),
          })),
          ...(caption?.trim() ? { caption: caption.trim() } : {}),
        }
        const transportPlaintext = JSON.stringify(envelope)
        const { encrypted_content, iv: envelopeIv } = await encryptOutboundText(
          ctx.unwrappedPrivateKey,
          transportPlaintext,
          ctx.cryptoCtx
        )

        // Album uses the first item's path/iv as primary media_* fields so the
        // server/legacy clients still see a valid media reference.
        const first = uploaded[0]
        const { via, serverMessage, outboxId } = await sendChatMessageOverTransport({
          chat_id: ctx.activeChatId,
          transport_mode: ctx.cryptoCtx.mode,
          plaintext: transportPlaintext,
          sender_private_key: ctx.unwrappedPrivateKey,
          my_user_id: ctx.userId,
          peer_user_id: directPeerUserId ?? undefined,
          content: encrypted_content,
          iv: envelopeIv,
          media_path: first.filePath,
          media_type: items[0].segmentClass,
          media_iv: first.mediaIvB64,
          media_original_bytes: first.workSize,
        })

        if (via === 'REST' && serverMessage) {
          const decrypted = await decryptApiMessageRow(ctx.unwrappedPrivateKey, ctx.cryptoCtx, serverMessage)
          const node =
            (ctx.cryptoCtx.mode === 'DIRECT' || ctx.cryptoCtx.mode === 'SELF') &&
            (decrypted.plaintext === '' || decrypted.plaintext === '[DECRYPT_FAIL]')
              ? { ...decrypted, plaintext: transportPlaintext }
              : decrypted
          void cacheMessage(node).catch(() => {})
          appendMessage(node)
          vibrateShort(20)
          return
        }
        if (via === 'QUEUED' && outboxId) {
          appendMessage({
            id: `pending-${outboxId}`,
            chat_id: ctx.activeChatId,
            sender_id: ctx.userId,
            plaintext: transportPlaintext,
            media_path: first.filePath,
            media_type: items[0].segmentClass,
            media_iv: first.mediaIvB64,
            reply_to_id: null,
            read_at: null,
            burn_at: null,
            reactions: {},
            created_at: new Date().toISOString(),
            _pending: true,
          } as DecryptedMessage)
          vibrateShort(10)
        }
      } catch (err) {
        console.error('[SEND_ALBUM] failed', err)
        toastError(explainSendError(err), { title: 'SEND FAILED' })
        throw err
      }
    },
    [activeChatId, userId, unwrappedPrivateKey, directPeerUserId, cryptoCtx, appendMessage, transmitBinary]
  )

  return { transmitBinary, sendMedia: transmitBinary, transmitAlbum, sendAlbum: transmitAlbum }
}
