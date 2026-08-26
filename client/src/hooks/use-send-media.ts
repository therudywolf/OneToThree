'use client'

import imageCompression from 'browser-image-compression'
import { useCallback } from 'react'
import {
  encryptOutboundText,
  encryptOutboundTextV2,
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
import { generateTinyPreview } from '@/lib/tiny-preview'
import { explainSendError } from '@/lib/explain-send-error'
import { useTranslation } from '@/hooks/use-translation'
import { toastError, toastWarn } from '@/store/toastStore'
import { useUploadProgressStore } from '@/store/uploadProgressStore'
import type { DecryptedMessage } from '@/types/chat'

/**
 * Sprint M1-5 — register a presigned PUT in the global upload-progress
 * store so the chat input can render a progress bar with cancel.
 *
 * The caller never holds the AbortController itself: cancelUpload(id) on
 * the store reaches the controller via the shared map.
 */
async function trackedInject(
  id: string,
  fileName: string,
  url: string,
  mime: string,
  payload: ArrayBuffer
): Promise<void> {
  const store = useUploadProgressStore.getState()
  const controller = new AbortController()
  store.addUpload(id, fileName, payload.byteLength, controller)
  try {
    await injectWithRetry(url, mime, payload, 3, {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        useUploadProgressStore.getState().setProgress(id, loaded, total)
      },
    })
    useUploadProgressStore.getState().setStatus(id, 'done')
    setTimeout(() => useUploadProgressStore.getState().removeUpload(id), 1500)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status: 'cancelled' | 'error' =
      msg === 'UPLOAD_CANCELLED' ? 'cancelled' : 'error'
    useUploadProgressStore.getState().setStatus(id, status, msg)
    setTimeout(() => useUploadProgressStore.getState().removeUpload(id), 4000)
    throw err
  }
}

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
  /** Sprint M1-6 — when true, skip image compression and send the original bytes. */
  sendOriginal?: boolean
  /**
   * D6 — armed burn timer (seconds) for ephemeral media. Threaded through to
   * `sendChatMessageOverTransport` so photos/voice/video/album/GIF/stickers
   * honour the burn flame just like text messages do.
   */
  burn_duration_secs?: number | null
  /** Voice/video-circle length in ms, captured at record time (issue #11). */
  durationMs?: number
  /** Voice-note amplitude peaks (0–100 ints), captured at record time. */
  waveform?: number[]
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
/**
 * Sprint M1-5 — XHR-based upload (vs the previous fetch impl) so we can
 * surface real-time `progress` events to the UI and honour an
 * AbortSignal for user-initiated cancel. Retry semantics preserved.
 */
async function injectOnce(opts: {
  url: string
  mime: string
  payload: ArrayBuffer
  timeoutMs: number
  signal?: AbortSignal
  onProgress?: (loaded: number, total: number) => void
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('UPLOAD_CANCELLED'))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', opts.url)
    xhr.setRequestHeader('Content-Type', opts.mime)
    xhr.timeout = opts.timeoutMs
    if (opts.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total)
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`STORAGE_PUT_${xhr.status}: ${xhr.responseText.slice(0, 256)}`))
    }
    xhr.onerror = () => reject(new Error('STORAGE_PUT_NETWORK'))
    xhr.ontimeout = () => reject(new Error('STORAGE_PUT_TIMEOUT'))
    xhr.onabort = () => reject(new Error('UPLOAD_CANCELLED'))
    const onAbort = () => xhr.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    xhr.send(opts.payload)
  })
}

async function injectWithRetry(
  url: string,
  mime: string,
  payload: ArrayBuffer,
  maxAttempts = 3,
  hooks?: {
    signal?: AbortSignal
    onProgress?: (loaded: number, total: number) => void
  }
): Promise<void> {
  const PER_ATTEMPT_TIMEOUT_MS = 30000
  let attempt = 0
  let lastError: unknown
  while (attempt < maxAttempts) {
    if (hooks?.signal?.aborted) throw new Error('UPLOAD_CANCELLED')
    attempt++
    try {
      await injectOnce({
        url,
        mime,
        payload,
        timeoutMs: PER_ATTEMPT_TIMEOUT_MS,
        signal: hooks?.signal,
        onProgress: hooks?.onProgress,
      })
      return
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      // Don't retry user-initiated cancels.
      if (msg === 'UPLOAD_CANCELLED') throw err
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
 * A temp-chat guest peer is a TEXT-ONLY surface.
 *
 * guest-allowed-routes.ts lets a guest POST /api/messages/send but neither
 * /api/storage/upload-url nor /api/storage/download-url, and the guest chat
 * view renders `m.text` and nothing else — so an attachment could not be
 * fetched or shown on the other side even if it went out. It did not go out
 * either: encryptOutboundTextV2 answers a guest DIRECT frame with the
 * sanctioned v1 stub (empty content, no dr_slots), and the transport only
 * takes its guest fan-out branch when the caller passes `peer_is_guest` —
 * which only the text send does. Every photo/voice/video/file/GIF/sticker and
 * every album therefore died on DIRECT_V2_REQUIRED *after* the encrypted bytes
 * had already been PUT to MinIO, leaving the object orphaned.
 *
 * So refuse before the presign, and tell the host why instead of leaking a
 * protocol code into the toast.
 */
export const GUEST_CHAT_TEXT_ONLY_CODE = 'SEND_GUEST_CHAT_TEXT_ONLY'

/** True for a DIRECT chat whose peer the server marked as a temp-chat guest. */
export function isTextOnlyGuestChat(ctx: ChatCryptoContext | null | undefined): boolean {
  return ctx?.mode === 'DIRECT' && ctx.peerIsGuest === true
}

/** explainSendError + the media-only guest case (it has no text equivalent). */
function explainMediaSendError(err: unknown): string {
  if (err instanceof Error && err.message === GUEST_CHAT_TEXT_ONLY_CODE) {
    return 'Temporary guest chats are text only — the guest cannot download attachments.'
  }
  return explainSendError(err)
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
  // Guest chats: bail here, i.e. before a single byte is encrypted, presigned
  // or uploaded. See GUEST_CHAT_TEXT_ONLY_CODE.
  if (isTextOnlyGuestChat(ctx.cryptoCtx)) throw new Error(GUEST_CHAT_TEXT_ONLY_CODE)
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
  /** Sprint M1-8 — base64 data URL for blurred placeholder. Image segments only. */
  tinyPreview?: string
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
  const normalizedMime = mimeType.toLowerCase()
  const shouldCompressImage =
    segmentClass === 'image' &&
    rawBlob.size > IMAGE_COMPRESSION_THRESHOLD_BYTES &&
    normalizedMime !== 'image/gif' &&
    !options.sendOriginal
  if (shouldCompressImage) {
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

  // Sprint M1-8 — only generate tiny placeholder for raster images. Skip
  // GIFs (already small) and non-image segments. Best-effort, never blocks.
  let tinyPreview: string | undefined
  if (segmentClass === 'image' && normalizedMime !== 'image/gif') {
    try {
      const preview = await generateTinyPreview(workBlob)
      if (preview) tinyPreview = preview
    } catch {
      /* ignore — placeholder is purely cosmetic */
    }
  }

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
      tinyPreview,
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
    tinyPreview,
  }
}

type TransportCryptoFields = {
  encrypted_content: string
  iv: string
  protocol_version: 1 | 2
  dr_header: string | null
  dr_init: string | null
  dr_slots: Array<{ device_id: string; ciphertext: string; iv: string }> | null
}

/**
 * Encrypt a media/album transport envelope for the chat mode.
 *
 * DIRECT and SELF are Double-Ratchet v2 (mirrors the text send path in
 * useSendMessage). Previously the media path used the v1 `encryptOutboundText`
 * for every mode, so DIRECT attachments went out as protocol_version=1 fan-out
 * slots — which v2-only receivers reject (`ERR_DIRECT_V1_REJECTED`), leaving
 * every image/voice/file/album undecryptable for the recipient. SECTOR/PUBLIC
 * stay on the single-key legacy path.
 */
async function encryptEnvelopeForMode(
  privateKey: CryptoKey,
  plaintext: string,
  cryptoCtx: ChatCryptoContext,
  ids: { userId: string; peerUserId: string | null }
): Promise<TransportCryptoFields> {
  if (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') {
    const enc = await encryptOutboundTextV2(privateKey, plaintext, cryptoCtx, {
      ownerUserId: ids.userId,
      peerUserId: ids.peerUserId,
    })
    return {
      encrypted_content: enc.encrypted_content,
      iv: enc.iv,
      protocol_version: enc.protocol_version,
      dr_header: enc.dr_header,
      dr_init: enc.dr_init,
      dr_slots: enc.dr_slots ?? null,
    }
  }
  const enc = await encryptOutboundText(privateKey, plaintext, cryptoCtx)
  return {
    encrypted_content: enc.encrypted_content,
    iv: enc.iv,
    protocol_version: 1,
    dr_header: null,
    dr_init: null,
    dr_slots: null,
  }
}

export function useSendMedia(
  cryptoCtx: ChatCryptoContext | null,
  directPeerUserId: string | null
) {
  const { t } = useTranslation()
  const activeChatId = useSessionStore(s => s.activeChatId)
  const userId = useSessionStore(s => s.userId)
  const unwrappedPrivateKey = useSessionStore(s => s.unwrappedPrivateKey)
  const myEcdhPublicKeyJwk = useSessionStore(s => s.myEcdhPublicKeyJwk)
  const priorMyEcdhPublicKeysJwk = useSessionStore(s => s.priorMyEcdhPublicKeysJwk)
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
        toastError(explainMediaSendError(err), { title: 'SEND FAILED' })
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
          ...(prepared.tinyPreview ? { thumbhash: prepared.tinyPreview } : {}),
          ...(typeof options?.durationMs === 'number' && options.durationMs > 0
            ? { durationMs: options.durationMs }
            : {}),
          ...(Array.isArray(options?.waveform) && options.waveform.length > 0
            ? { waveform: options.waveform }
            : {}),
        }
        const transportPlaintext = JSON.stringify(envelope)
        const enc = await encryptEnvelopeForMode(
          ctx.unwrappedPrivateKey,
          transportPlaintext,
          ctx.cryptoCtx,
          { userId: ctx.userId, peerUserId: directPeerUserId ?? null }
        )

        const { uploadUrl, filePath, contentType } = await postUploadUrl({
          chatId: ctx.activeChatId,
          fileName: prepared.label,
          fileType: prepared.mimeType,
          fileSize: prepared.workSize,
        })
        await trackedInject(
          `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          prepared.label,
          uploadUrl,
          contentType ?? prepared.mimeType,
          prepared.uploadPayload
        )

        const result = await sendChatMessageOverTransport({
          chat_id: ctx.activeChatId,
          transport_mode: ctx.cryptoCtx.mode,
          plaintext: transportPlaintext,
          sender_private_key: ctx.unwrappedPrivateKey,
          my_user_id: ctx.userId,
          peer_user_id: directPeerUserId ?? undefined,
          my_ecdh_public_key_jwk: myEcdhPublicKeyJwk,
          content: enc.encrypted_content,
          iv: enc.iv,
          protocol_version: enc.protocol_version,
          dr_header: enc.dr_header,
          dr_init: enc.dr_init,
          dr_slots: enc.dr_slots,
          media_path: filePath,
          media_type: segmentClass,
          media_iv: prepared.mediaIvB64,
          media_original_bytes: prepared.workSize,
          ...(options?.burn_duration_secs != null
            ? { burn_duration_secs: options.burn_duration_secs }
            : {}),
        })
        const { via, serverMessage, outboxId, partialDelivery } = result
        if (partialDelivery && partialDelivery.failedDeviceIds.length > 0) {
          toastWarn(
            `${t('chat.partialDeliveryWarning')} (${partialDelivery.failedDeviceIds.length}/${partialDelivery.attemptedDeviceIds.length})`,
            { title: t('chat.partialDeliveryTitle'), ttlMs: 7000 }
          )
        }

        if (via === 'REST' && serverMessage) {
          const decrypted = await decryptApiMessageRow(ctx.unwrappedPrivateKey, ctx.cryptoCtx, serverMessage, undefined, { myUserId: ctx.userId, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk })
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
            burn_duration_secs: options?.burn_duration_secs ?? null,
            reactions: {},
            created_at: new Date().toISOString(),
            _pending: true,
          } as DecryptedMessage)
          vibrateShort(10)
        }
      } catch (err) {
        console.error('[SEND_MEDIA] failed', err)
        toastError(explainMediaSendError(err), { title: 'SEND FAILED' })
        throw err
      }
    },
    [activeChatId, userId, unwrappedPrivateKey, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk, directPeerUserId, cryptoCtx, appendMessage, t]
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
        toastError(explainMediaSendError(err), { title: 'SEND FAILED' })
        throw err
      }

      if (items.length === 0) return
      if (items.length > MAX_ALBUM_ITEMS) {
        toastError(`Albums are limited to ${MAX_ALBUM_ITEMS} items.`, { title: 'ALBUM' })
        throw new Error('ALBUM_TOO_LARGE')
      }
      // D6 — burn applies to the whole album message; take it from the first
      // item's options (the composer arms it identically on every item).
      const albumBurnDurationSecs = items[0]?.options?.burn_duration_secs ?? null
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
            const { uploadUrl, filePath, contentType } = await postUploadUrl({
              chatId: ctx.activeChatId,
              fileName: p.label,
              fileType: p.mimeType,
              fileSize: p.workSize,
            })
            await trackedInject(
              `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              p.label,
              uploadUrl,
              contentType ?? p.mimeType,
              p.uploadPayload
            )
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
        const enc = await encryptEnvelopeForMode(
          ctx.unwrappedPrivateKey,
          transportPlaintext,
          ctx.cryptoCtx,
          { userId: ctx.userId, peerUserId: directPeerUserId ?? null }
        )

        // Album uses the first item's path/iv as primary media_* fields so the
        // server/legacy clients still see a valid media reference.
        const first = uploaded[0]
        const result = await sendChatMessageOverTransport({
          chat_id: ctx.activeChatId,
          transport_mode: ctx.cryptoCtx.mode,
          plaintext: transportPlaintext,
          sender_private_key: ctx.unwrappedPrivateKey,
          my_user_id: ctx.userId,
          peer_user_id: directPeerUserId ?? undefined,
          my_ecdh_public_key_jwk: myEcdhPublicKeyJwk,
          content: enc.encrypted_content,
          iv: enc.iv,
          protocol_version: enc.protocol_version,
          dr_header: enc.dr_header,
          dr_init: enc.dr_init,
          dr_slots: enc.dr_slots,
          media_path: first.filePath,
          media_type: items[0].segmentClass,
          media_iv: first.mediaIvB64,
          media_original_bytes: first.workSize,
          ...(albumBurnDurationSecs != null
            ? { burn_duration_secs: albumBurnDurationSecs }
            : {}),
          // Link EVERY album object to the message (not just item 1) so the
          // orphan-cleanup sweep doesn't hard-delete items 2..N after 24h.
          attachment_keys: uploaded.map((u) => u.filePath),
        })
        const { via, serverMessage, outboxId, partialDelivery } = result
        if (partialDelivery && partialDelivery.failedDeviceIds.length > 0) {
          toastWarn(
            `${t('chat.partialDeliveryWarning')} (${partialDelivery.failedDeviceIds.length}/${partialDelivery.attemptedDeviceIds.length})`,
            { title: t('chat.partialDeliveryTitle'), ttlMs: 7000 }
          )
        }

        if (via === 'REST' && serverMessage) {
          const decrypted = await decryptApiMessageRow(ctx.unwrappedPrivateKey, ctx.cryptoCtx, serverMessage, undefined, { myUserId: ctx.userId, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk })
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
            burn_duration_secs: albumBurnDurationSecs ?? null,
            reactions: {},
            created_at: new Date().toISOString(),
            _pending: true,
          } as DecryptedMessage)
          vibrateShort(10)
        }
      } catch (err) {
        console.error('[SEND_ALBUM] failed', err)
        toastError(explainMediaSendError(err), { title: 'SEND FAILED' })
        throw err
      }
    },
    [activeChatId, userId, unwrappedPrivateKey, myEcdhPublicKeyJwk, priorMyEcdhPublicKeysJwk, directPeerUserId, cryptoCtx, appendMessage, t, transmitBinary]
  )

  return { transmitBinary, sendMedia: transmitBinary, transmitAlbum, sendAlbum: transmitAlbum }
}
