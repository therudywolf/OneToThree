import type { SupabaseClient } from '@supabase/supabase-js'
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

export async function buildChatCryptoContext(
  supabase: SupabaseClient,
  chatId: string,
  myUserId: string,
  privateKey: CryptoKey
): Promise<ChatCryptoContext | null> {
  const { data: chat, error } = await supabase
    .from('chats')
    .select('is_group')
    .eq('id', chatId)
    .single()

  if (error || !chat) return null

  if (chat.is_group) {
    const { data: row } = await supabase
      .from('chat_members')
      .select('encrypted_group_key')
      .eq('chat_id', chatId)
      .eq('user_id', myUserId)
      .single()

    if (!row?.encrypted_group_key) {
      throw new Error('MISSING_GROUP_KEY')
    }
    const groupKey = await unwrapGroupKeyFromStoredPayload(
      privateKey,
      row.encrypted_group_key
    )
    return { mode: 'group', groupKey }
  }

  const { data: members } = await supabase
    .from('chat_members')
    .select('user_id')
    .eq('chat_id', chatId)

  const other = members?.find((m) => m.user_id !== myUserId)
  if (!other) throw new Error('MISSING_PEER')

  const { data: peer } = await supabase
    .from('users')
    .select('public_key_jwk')
    .eq('id', other.user_id)
    .single()

  if (!peer?.public_key_jwk) throw new Error('MISSING_PEER_KEY')

  return { mode: 'direct', peerPublicKeyJwk: peer.public_key_jwk }
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
