'use client'

import { useCallback } from 'react'
import {
  getAesKeyForChat,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { encryptBinary } from '@/lib/crypto'
import { postUploadUrl } from '@/lib/api/storage'
import { getFmSocket } from '@/lib/api/socket'
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
    async (blob: Blob, mediaType: 'audio' | 'video', _caption?: string) => {
      if (!activeChatId || !userId || !unwrappedPrivateKey || !cryptoCtx) {
        return
      }

      const aesKey = await getAesKeyForChat(unwrappedPrivateKey, cryptoCtx)
      const plain = await blob.arrayBuffer()
      const { cipher, ivBase64 } = await encryptBinary(aesKey, plain)

      const fileType =
        mediaType === 'audio' ? 'audio/webm' : 'video/webm'
      const fileName =
        mediaType === 'audio'
          ? `voice-${Date.now()}.webm`
          : `video-${Date.now()}.webm`

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
