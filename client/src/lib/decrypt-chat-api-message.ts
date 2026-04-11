import {
  decryptInboundText,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import type { DecryptedMessage } from '@/types/chat'

export type ApiMessageRow = {
  id: string
  chat_id: string
  sender_id: string
  reply_to_id?: string | null
  content: string | null
  iv: string | null
  media_path?: string | null
  media_type?: string | null
  media_iv?: string | null
  read_at?: string | null
  created_at: string
}

export async function decryptApiMessageRow(
  unwrappedPrivateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext,
  m: ApiMessageRow
): Promise<DecryptedMessage> {
  let plaintext = ''
  if (m.content != null && m.iv != null && m.content !== '') {
    try {
      plaintext = await decryptInboundText(
        unwrappedPrivateKey,
        cryptoCtx,
        m.content,
        m.iv
      )
    } catch {
      plaintext = '[DECRYPT_FAIL]'
    }
  }
  return {
    id: m.id,
    chat_id: m.chat_id,
    sender_id: m.sender_id,
    reply_to_id: m.reply_to_id ?? null,
    plaintext,
    created_at: m.created_at,
    read_at: m.read_at ?? null,
    media_path: m.media_path,
    media_type:
      m.media_type === 'audio' ||
      m.media_type === 'video' ||
      m.media_type === 'image' ||
      m.media_type === 'file'
        ? m.media_type
        : null,
    media_iv: m.media_iv,
  }
}
