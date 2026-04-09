'use client'

import { useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { encryptOutboundText, getAesKeyForChat, type ChatCryptoContext } from '@/lib/chat-crypto'
import { encryptBlob } from '@/lib/media-crypto'
import { useChatStore } from '@/store/chatStore'

const BUCKET = 'secure_media'

export function useSendMediaMessage(cryptoCtx: ChatCryptoContext | null) {
  const supabase = createClient()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const unwrappedPrivateKey = useChatStore((s) => s.unwrappedPrivateKey)

  const sendMedia = useCallback(
    async (blob: Blob, mediaType: 'audio' | 'video', caption?: string) => {
      if (!activeChatId || !userId || !unwrappedPrivateKey || !cryptoCtx) {
        return
      }

      const aesKey = await getAesKeyForChat(unwrappedPrivateKey, cryptoCtx)
      const { encryptedBuffer, ivBase64 } = await encryptBlob(aesKey, blob)

      const objectId = `${activeChatId}/${crypto.randomUUID()}.bin`
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(objectId, encryptedBuffer, {
          contentType: 'application/octet-stream',
          upsert: false,
        })
      if (upErr) throw upErr

      let encrypted_content: string | null = null
      let iv: string | null = null
      const cap = caption?.trim()
      if (cap) {
        const enc = await encryptOutboundText(unwrappedPrivateKey, cap, cryptoCtx)
        encrypted_content = enc.encrypted_content
        iv = enc.iv
      }

      const { error } = await supabase.from('messages').insert({
        chat_id: activeChatId,
        sender_id: userId,
        encrypted_content,
        iv,
        media_path: objectId,
        media_type: mediaType,
        media_iv: ivBase64,
      })
      if (error) throw error
    },
    [activeChatId, userId, unwrappedPrivateKey, cryptoCtx, supabase]
  )

  return { sendMedia }
}
