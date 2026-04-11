import { postSendChatMessage, type SendChatMessageBody } from '@/lib/api/messages'
import type { ApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { getFmSocket } from '@/lib/api/socket'

/**
 * Prefers WebSocket when connected; otherwise persists via REST so ciphertext
 * reaches PostgreSQL even if the socket path is down.
 */
export async function sendChatMessageOverTransport(
  body: SendChatMessageBody
): Promise<{ via: 'ws' | 'rest'; serverMessage?: ApiMessageRow }> {
  const sock = getFmSocket()
  if (sock.connected) {
    sock.send({
      type: 'chat_message',
      ...body,
    })
    return { via: 'ws' }
  }
  const serverMessage = await postSendChatMessage(body)
  return { via: 'rest', serverMessage }
}
