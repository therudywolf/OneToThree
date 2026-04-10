import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  importEcdhPublicKey,
} from './crypto'

export type ChatCryptoContext =
  | { mode: 'direct'; peerPublicKeyJwk: string }
  | { mode: 'group'; groupKey: CryptoKey }

/**
 * Loads chat crypto material from the API (Phase 2). Until then returns null.
 */
export async function buildChatCryptoContext(
  _chatId: string,
  _myUserId: string,
  _privateKey: CryptoKey
): Promise<ChatCryptoContext | null> {
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
