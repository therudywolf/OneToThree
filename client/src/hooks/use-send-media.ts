'use client'

import { useCallback } from 'react'
import {
  getAesKeyForChat,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { encryptBinary } from '@/lib/crypto'
import { postUploadUrl } from '@/lib/api/storage'
import { getFmSocket } from '@/lib/api/socket'
import { isMediaTooLarge, MEDIA_TOO_LARGE_CODE } from '@/lib/media-limits'
import { useChatStore } from '@/store/chatStore'

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
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': fileType },
        body: cipher,
      })
      if (put.ok) return
      lastErr = new Error(`MINIO_PUT_FAILED_${put.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 350 * attempt))
  }
  throw (lastErr instanceof Error ? lastErr : new Error('MINIO_PUT_FAILED'))
}

export function useSendMedia(cryptoCtx: ChatCryptoContext | null) {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)

  const sendMedia = useCallback(
    async (
      blob: Blob,
      mediaType: 'audio' | 'video' | 'image',
      _caption?: string,
      options?: { fileName?: string; fileType?: string }
    ) => {
      if (!activeChatId || !userId || !unwrappedPrivateKey || !cryptoCtx) {
        return
      }
      // Guard before any ArrayBuffer allocation to avoid browser OOM.
      if (isMediaTooLarge(blob.size)) {
        throw new Error(MEDIA_TOO_LARGE_CODE)
      }

      const aesKey = await getAesKeyForChat(unwrappedPrivateKey, cryptoCtx)
      const plain = await blob.arrayBuffer()
      const { cipher, ivBase64 } = await encryptBinary(aesKey, plain)

      const inferredType =
        mediaType === 'audio'
          ? 'audio/webm'
          : mediaType === 'video'
            ? 'video/webm'
            : 'image/jpeg'
      const fileType = options?.fileType?.trim() || inferredType
      const ext =
        fileType.includes('png')
          ? 'png'
          : fileType.includes('gif')
            ? 'gif'
            : fileType.includes('webp')
              ? 'webp'
              : fileType.includes('jpeg') || fileType.includes('jpg')
                ? 'jpg'
                : fileType.includes('mp4')
                  ? 'mp4'
                  : fileType.includes('mpeg')
                    ? 'mp3'
                    : 'webm'
      const defaultName =
        mediaType === 'audio'
          ? `voice-${Date.now()}.${ext}`
          : mediaType === 'video'
            ? `video-${Date.now()}.${ext}`
            : `image-${Date.now()}.${ext}`
      const fileName = options?.fileName?.trim() || defaultName

      const { uploadUrl, filePath } = await postUploadUrl({
        chatId: activeChatId,
        fileName,
        fileType,
      })

      await putWithRetry(uploadUrl, fileType, cipher)

      getFmSocket().send({
        type: 'chat_message',
        chat_id: activeChatId,
        content: null,
        iv: null,
        media_path: filePath,
        media_type: mediaType,
        media_iv: ivBase64,
      })
    },
    [activeChatId, userId, unwrappedPrivateKey, cryptoCtx]
  )

  return { sendMedia }
}
