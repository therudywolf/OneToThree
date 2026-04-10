import { decryptInboundText, type ChatCryptoContext } from '@/lib/chat-crypto'
import type { DecryptedMessage } from '@/types/chat'

export type DbMessageRow = {
  id: string
  chat_id: string
  sender_id: string
  encrypted_content: string | null
  iv: string | null
  media_path: string | null
  media_type: string | null
  media_iv: string | null
  created_at: string
}

export async function rowToDecryptedMessage(
  row: DbMessageRow,
  privateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext
): Promise<DecryptedMessage | null> {
  let plaintext = ''
  if (
    row.encrypted_content != null &&
    row.encrypted_content !== '' &&
    row.iv != null &&
    row.iv !== ''
  ) {
    try {
      plaintext = await decryptInboundText(
        privateKey,
        cryptoCtx,
        row.encrypted_content,
        row.iv
      )
    } catch {
      return null
    }
  }

  if (!plaintext && !row.media_path) {
    return null
  }

  const mt = row.media_type
  return {
    id: row.id,
    chat_id: row.chat_id,
    sender_id: row.sender_id,
    plaintext,
    created_at: row.created_at,
    media_path: row.media_path,
    media_type: mt === 'audio' || mt === 'video' ? mt : null,
    media_iv: row.media_iv,
  }
}
