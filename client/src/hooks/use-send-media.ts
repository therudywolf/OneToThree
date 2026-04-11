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

function getSubtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('NO_SUBTLE')
  }
  return globalThis.crypto.subtle
}

async function putWithRetry(
  uploadUrl: string,
  fileType: string,
  cipher: ArrayBuffer,
  retries = 3
): Promise<void> {
  let attempt = 0
  let lastErr: unknown
  while (attempt < retries) {
    attempt++
    try {
      console.log(
        '[MEDIA UPLOAD] Attempting PUT to exact URL:',
        uploadUrl,
        `(attempt ${attempt}/${retries})`
      )
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': fileType },
        body: cipher,
      })
      if (put.ok) return
      const errText = await put.text().catch(() => '')
      console.error(
        '[MEDIA UPLOAD] PUT failed',
        put.status,
        put.statusText,
        errText ? errText.slice(0, 500) : ''
      )
      lastErr = new Error(`MINIO_PUT_FAILED_${put.status}`)
    } catch (err) {
      console.error('[MEDIA UPLOAD FATAL ERROR]', err)
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 350 * attempt))
  }
  throw lastErr instanceof Error ? lastErr : new Error('MINIO_PUT_FAILED')
}

function extFromMimeAndName(
  mediaType: 'audio' | 'video' | 'image' | 'file',
  fileType: string,
  fileName: string
): string {
  const ft = fileType.toLowerCase()
  if (ft.includes('png')) return 'png'
  if (ft.includes('gif')) return 'gif'
  if (ft.includes('webp')) return 'webp'
  if (ft.includes('jpeg') || ft.includes('jpg')) return 'jpg'
  if (ft.includes('mp4')) return 'mp4'
  if (ft.includes('quicktime')) return 'mov'
  if (ft.includes('mpeg') || ft.includes('mp3')) return 'mp3'
  if (ft.includes('ogg')) return 'ogg'
  if (ft.includes('wav')) return 'wav'
  if (ft.includes('pdf')) return 'pdf'
  if (ft.includes('zip')) return 'zip'
  if (mediaType === 'audio') return 'webm'
  if (mediaType === 'video') return 'webm'
  if (mediaType === 'image') return 'jpg'
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const m = base.match(/(\.[a-zA-Z0-9]{1,12})$/)
  return m ? m[1].replace('.', '').toLowerCase() : 'bin'
}

export function useSendMedia(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)
  const appendMessage = useChatStore((s) => s.appendMessage)

  const sendMedia = useCallback(
    async (
      blob: Blob,
      mediaType: 'audio' | 'video' | 'image' | 'file',
      _caption?: string,
      options?: { fileName?: string; fileType?: string }
    ) => {
      if (!activeChatId || !userId || !unwrappedPrivateKey || !cryptoCtx) {
        return
      }

      const inferredType =
        mediaType === 'audio'
          ? 'audio/webm'
          : mediaType === 'video'
            ? 'video/webm'
            : mediaType === 'image'
              ? 'image/jpeg'
              : 'application/octet-stream'
      const fileType = options?.fileType?.trim() || inferredType
      const ext = extFromMimeAndName(
        mediaType,
        fileType,
        options?.fileName ?? 'unnamed.bin'
      )
      const defaultName =
        mediaType === 'audio'
          ? `voice-${Date.now()}.${ext}`
          : mediaType === 'video'
            ? `video-${Date.now()}.${ext}`
            : mediaType === 'image'
              ? `image-${Date.now()}.${ext}`
              : `file-${Date.now()}.${ext}`
      const fileName = options?.fileName?.trim() || defaultName
      const uploadName = fileName.includes('.') ? fileName : `${fileName}.${ext}`

      let workBlob: Blob = blob
      if (mediaType === 'image') {
        const source =
          blob instanceof File
            ? blob
            : new File([blob], uploadName, { type: fileType })
        workBlob = await imageCompression(source, {
          maxWidthOrHeight: 1920,
          useWebWorker: true,
          initialQuality: 0.8,
        })
      }

      if (isMediaTooLarge(workBlob.size)) {
        throw new Error(MEDIA_TOO_LARGE_CODE)
      }

      const aesKey = await getAesKeyForChat(unwrappedPrivateKey, cryptoCtx)
      const fileKey = await generateAesGcm256Key()
      const plain = await workBlob.arrayBuffer()
      const fileIv = new Uint8Array(12)
      crypto.getRandomValues(fileIv)
      const cipher = await getSubtle().encrypt(
        { name: 'AES-GCM', iv: fileIv as BufferSource },
        fileKey,
        plain as BufferSource
      )
      const rawKey = await getSubtle().exportKey('raw', fileKey)
      const { cipher: wrapCipher, ivBase64: wrapIv } = await encryptBinary(
        aesKey,
        rawKey as ArrayBuffer
      )

      const envelope: AttachmentEnvelopeV1 = {
        p13: 'attachment',
        v: 1,
        fileName: uploadName,
        fileSize: workBlob.size,
        mimeType: fileType,
        wrapIv,
        wrapCt: arrayBufferToBase64(wrapCipher),
      }

      const { encrypted_content, iv } = await encryptOutboundText(
        unwrappedPrivateKey,
        JSON.stringify(envelope),
        cryptoCtx
      )

      const { uploadUrl, filePath } = await postUploadUrl({
        chatId: activeChatId,
        fileName: uploadName,
        fileType,
      })

      await putWithRetry(uploadUrl, fileType, cipher)

      const ivB64 = arrayBufferToBase64(
        fileIv.buffer.slice(
          fileIv.byteOffset,
          fileIv.byteOffset + fileIv.byteLength
        )
      )

      const { via, serverMessage } = await sendChatMessageOverTransport({
        chat_id: activeChatId,
        content: encrypted_content,
        iv,
        media_path: filePath,
        media_type: mediaType,
        media_iv: ivB64,
        media_original_bytes: workBlob.size,
      })
      if (via === 'rest' && serverMessage) {
        const row = await decryptApiMessageRow(
          unwrappedPrivateKey,
          cryptoCtx,
          serverMessage
        )
        await cacheMessage(row).catch(() => {
          /* best-effort */
        })
        appendMessage(row)
      }
    },
    [activeChatId, userId, unwrappedPrivateKey, cryptoCtx, appendMessage]
  )

  return { sendMedia }
}
