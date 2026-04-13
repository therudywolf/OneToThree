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
import type { AttachmentEnvelopeV1 } from '@/lib/attachment-envelope'
import { sendChatMessageOverTransport } from '@/lib/chat-message-transport'
import { decryptApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { cacheMessage } from '@/lib/message-cache'
import { postUploadUrl } from '@/lib/api/storage'
import { isMediaTooLarge, MEDIA_TOO_LARGE_CODE } from '@/lib/media-limits'
import { useChatStore } from '@/store/chatStore'
import { vibrateShort } from '@/lib/vibrate'

/**
 * PROJECT 13 :: BINARY_TRANSMISSION_PROTOCOL
 * Level: Connection Layer (Data Injection)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/** Maps common MIME types to file extensions for upload validation. */
const MIME_TO_EXT: Record<string, string> = {
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
  'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/aac': '.aac',
  'video/webm': '.webm', 'video/mp4': '.mp4', 'video/ogg': '.ogg',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'application/pdf': '.pdf',
}

function ensureExtension(name: string, mime: string): string {
  if (/\.[a-zA-Z0-9]{1,12}$/.test(name)) return name
  const base = mime.split(';')[0].trim().toLowerCase()
  const ext = MIME_TO_EXT[base] ?? (base.startsWith('audio/') ? '.webm' : base.startsWith('video/') ? '.webm' : '.bin')
  return `${name}${ext}`
}

const getSubtle = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) throw new Error('ERR_NO_SUBTLE_CRYPTO')
  return globalThis.crypto.subtle
}

/** [DATA_INJECTION_RETRY] :: Повторные попытки пробиться к хранилищу */
async function injectWithRetry(
  url: string,
  mime: string,
  payload: ArrayBuffer,
  maxAttempts = 3
): Promise<void> {
  let attempt = 0
  while (attempt < maxAttempts) {
    attempt++
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: payload,
      })
      if (response.ok) return
      
      const log = await response.text().catch(() => '')
      console.error(`>> [SYS.STORAGE] PUT_FAULT [${response.status}]:`, log.slice(0, 256))
    } catch (err) {
      console.error('>> [SYS.STORAGE] INJECTION_INTERRUPTED:', err)
    }
    await new Promise((r) => setTimeout(r, 400 * attempt))
  }
  throw new Error('STORAGE_INJECTION_FAILED')
}

export function useSendMedia(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore(s => s.activeChatId)
  const userId = useChatStore(s => s.userId)
  const unwrappedPrivateKey = useChatStore(s => s.unwrappedPrivateKey)
  const appendMessage = useChatStore(s => s.appendMessage)

  const transmitBinary = useCallback(
    async (
      rawBlob: Blob,
      segmentClass: 'audio' | 'video' | 'image' | 'file',
      options?: { label?: string; mime?: string }
    ) => {
      // [0] PRE_FLIGHT_CHECK
      if (!activeChatId || !userId || !unwrappedPrivateKey || !cryptoCtx) return

      const mimeType = options?.mime?.trim() || rawBlob.type || 'application/octet-stream'
      const rawLabel = options?.label?.trim() || `segment-${Date.now()}`
      // Ensure file name has a proper extension so the server allows the upload
      const label = ensureExtension(rawLabel, mimeType)
      
      let workBlob: Blob = rawBlob

      // [1] SEGMENT_CALIBRATION :: Сжатие оптики, если это изображение
      if (segmentClass === 'image') {
        const source = rawBlob instanceof File ? rawBlob : new File([rawBlob], label, { type: mimeType })
        workBlob = await imageCompression(source, {
          maxWidthOrHeight: 1920,
          useWebWorker: true,
          initialQuality: 0.8,
        })
      }

      if (isMediaTooLarge(workBlob.size)) throw new Error(MEDIA_TOO_LARGE_CODE)

      const isPublicMode = cryptoCtx.mode === 'PUBLIC'

      let uploadPayload: ArrayBuffer
      let encrypted_content: string
      let envelopeIv: string
      let mediaIvB64: string

      if (isPublicMode) {
        // PUBLIC mode: no encryption, upload raw data
        uploadPayload = await workBlob.arrayBuffer()
        const envelope: AttachmentEnvelopeV1 = {
          p13: 'attachment',
          v: 1,
          fileName: label,
          fileSize: workBlob.size,
          mimeType: mimeType,
          wrapIv: '',
          wrapCt: '',
        }
        const result = await encryptOutboundText(
          unwrappedPrivateKey,
          JSON.stringify(envelope),
          cryptoCtx
        )
        encrypted_content = result.encrypted_content
        envelopeIv = result.iv
        mediaIvB64 = 'public'
      } else {
        // [2] CRYPTOGRAPHIC_LOCKDOWN :: Глубокое шифрование сегмента
        const sectorAesKey = await getAesKeyForChat(unwrappedPrivateKey, cryptoCtx)
        if (!sectorAesKey) throw new Error('ERR_MISSING_SECTOR_KEY')
        const segmentKey = await generateAesGcm256Key()
        const plainData = await workBlob.arrayBuffer()

        const segmentIv = crypto.getRandomValues(new Uint8Array(12))

        // Шифруем сам контент
        const cipherData = await getSubtle().encrypt(
          { name: 'AES-GCM', iv: segmentIv },
          segmentKey,
          plainData
        )

        // Экспортируем и оборачиваем ключ сегмента ключом сектора
        const rawSegmentKey = await getSubtle().exportKey('raw', segmentKey)
        const { cipher: wrappedKey, ivBase64: wrapIv } = await encryptBinary(
          sectorAesKey,
          rawSegmentKey
        )

        // [3] ENVELOPE_GENERATION :: Формирование мета-инструкции
        const envelope: AttachmentEnvelopeV1 = {
          p13: 'attachment',
          v: 1,
          fileName: label,
          fileSize: workBlob.size,
          mimeType: mimeType,
          wrapIv,
          wrapCt: arrayBufferToBase64(wrappedKey),
        }

        const result = await encryptOutboundText(
          unwrappedPrivateKey,
          JSON.stringify(envelope),
          cryptoCtx
        )
        encrypted_content = result.encrypted_content
        envelopeIv = result.iv
        uploadPayload = cipherData
        mediaIvB64 = arrayBufferToBase64(segmentIv.buffer)
      }

      // [4] TRANSPORT_HANDSHAKE :: Резервирование пути в облаке
      const { uploadUrl, filePath } = await postUploadUrl({
        chatId: activeChatId,
        fileName: label,
        fileType: mimeType,
      })

      // [5] DATA_INJECTION :: Загрузка блоба
      await injectWithRetry(uploadUrl, mimeType, uploadPayload)

      // [6] SIGNAL_BROADCAST :: Публикация сегмента в фид сектора
      const { via, serverMessage } = await sendChatMessageOverTransport({
        chat_id: activeChatId,
        content: encrypted_content,
        iv: envelopeIv,
        media_path: filePath,
        media_type: segmentClass,
        media_iv: mediaIvB64,
        media_original_bytes: workBlob.size,
      })

      if (via === 'REST' && serverMessage) {
        const node = await decryptApiMessageRow(unwrappedPrivateKey, cryptoCtx, serverMessage)
        void cacheMessage(node).catch(() => {})
        appendMessage(node)
        vibrateShort(20) // Подтверждение успешного диспатча
      }
    },
    [activeChatId, userId, unwrappedPrivateKey, cryptoCtx, appendMessage]
  )

  return { transmitBinary, sendMedia: transmitBinary }
}

