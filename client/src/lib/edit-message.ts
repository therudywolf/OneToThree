import type { ChatCryptoContext } from '@/lib/chat-crypto'
import type { EditMessageBody } from '@/lib/api/messages'

/**
 * Build the PATCH body to re-encrypt an edited message under the SAME crypto
 * context as the original send. Extracted from chat-input (Wave C) so the
 * E2EE-branch logic is isolated and node-tested:
 *  - DIRECT / SELF: fan-out slots are re-encrypted server-side, so send null
 *    content (the client re-fetches the decrypted plaintext).
 *  - SECTOR: re-encrypt with the current group key.
 *  - PUBLIC: base64-encode the plaintext.
 */
export async function buildEditBody(
  cryptoCtx: ChatCryptoContext,
  newText: string
): Promise<EditMessageBody> {
  if (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') {
    return { content: null, iv: null }
  }
  if (cryptoCtx.mode === 'SECTOR') {
    const { encryptMessage } = await import('@/lib/crypto')
    const { ciphertext, iv } = await encryptMessage(cryptoCtx.groupKey, newText)
    return { content: ciphertext, iv }
  }
  // PUBLIC
  return { content: btoa(unescape(encodeURIComponent(newText))), iv: 'public' }
}
