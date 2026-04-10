import { API_URL } from '@/lib/api/auth'
import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  importEcdhPublicKey,
} from './crypto'
import { unwrapGroupKeyFromStoredPayload } from './chat-logic'

export type ChatCryptoContext =
  | { mode: 'direct'; peerPublicKeyJwk: string }
  | { mode: 'group'; groupKey: CryptoKey }

type ChatDetailResponse = {
  chat: { type: string }
  members: Array<{
    user_id: string
    ecdh_public_key_jwk: string | null
    encrypted_group_key: string | null
  }>
}

/** Loads member keys / wrapped group key for the active chat. */
export async function buildChatCryptoContext(
  chatId: string,
  myUserId: string,
  privateKey: CryptoKey
): Promise<ChatCryptoContext | null> {
  const res = await fetch(`${API_URL}/chats/${chatId}`, {
    credentials: 'include',
  })
  if (!res.ok) {
    return null
  }
  const data = (await res.json()) as ChatDetailResponse
  const { chat, members } = data

  if (chat.type === 'public_open') {
    return null
  }

  if (chat.type === 'direct_e2e') {
    const other = members.find((m) => m.user_id !== myUserId)
    if (!other?.ecdh_public_key_jwk) {
      throw new Error('MISSING_PEER_ECDH')
    }
    return { mode: 'direct', peerPublicKeyJwk: other.ecdh_public_key_jwk }
  }

  if (chat.type === 'group_e2e') {
    const me = members.find((m) => m.user_id === myUserId)
    if (!me?.encrypted_group_key) {
      throw new Error('MISSING_GROUP_KEY')
    }
    const groupKey = await unwrapGroupKeyFromStoredPayload(
      privateKey,
      me.encrypted_group_key
    )
    return { mode: 'group', groupKey }
  }

  return null
}

export async function encryptOutboundText(
  privateKey: CryptoKey,
  plain: string,
  ctx: ChatCryptoContext
): Promise<{ encrypted_content: string; iv: string }> {
  if (ctx.mode === 'group') {
    const { ciphertext, iv } = await encryptMessage(ctx.groupKey, plain)
    return { encrypted_content: ciphertext, iv }
  }
  const peerPub = await importEcdhPublicKey(ctx.peerPublicKeyJwk)
  const sk = await deriveSharedSecret(privateKey, peerPub)
  const { ciphertext, iv } = await encryptMessage(sk, plain)
  return { encrypted_content: ciphertext, iv }
}

export async function decryptInboundText(
  privateKey: CryptoKey,
  ctx: ChatCryptoContext,
  encrypted_content: string,
  iv: string
): Promise<string> {
  if (ctx.mode === 'group') {
    return decryptMessage(ctx.groupKey, encrypted_content, iv)
  }
  const peerPub = await importEcdhPublicKey(ctx.peerPublicKeyJwk)
  const sk = await deriveSharedSecret(privateKey, peerPub)
  return decryptMessage(sk, encrypted_content, iv)
}

/** Same AES-GCM key used for text and binary payloads in a chat. */
export async function getAesKeyForChat(
  privateKey: CryptoKey,
  ctx: ChatCryptoContext
): Promise<CryptoKey> {
  if (ctx.mode === 'group') {
    return ctx.groupKey
  }
  const peerPub = await importEcdhPublicKey(ctx.peerPublicKeyJwk)
  return deriveSharedSecret(privateKey, peerPub)
}
