'use client'

/**
 * Stage 3 :: CHAT MESSAGE TRANSPORT (unified contract dispatcher)
 * DIRECT  -> per-device fan-out slots
 * SECTOR  -> shared-key legacy ciphertext
 * PUBLIC  -> plaintext-b64 legacy payload
 */

import { API_URL } from '@/lib/api/auth'
import type { SendChatMessageBody } from '@/lib/api/messages'
import { buildFanoutSlots } from './fanout-crypto'
import { getClientDeviceId } from './client-device'
import { enqueueOutbox, registerOutboxSync } from './outbox'
import type { ApiMessageRow } from './decrypt-chat-api-message'

export type SendMessageOptions = {
  chatId: string
  plaintext: string
  /** Required for fan-out mode (direct_e2e) */
  senderPrivateKey?: CryptoKey
  myUserId?: string
  peerUserId?: string
  /** Legacy single-ciphertext fields (group_e2e / public_open) */
  content?: string | null
  iv?: string | null
  mediaPath?: string | null
  mediaType?: string | null
  mediaIv?: string | null
  replyToId?: string | null
  mediaOriginalBytes?: number
  burnAt?: string | null
  /** 'fanout' = per-device slots, 'legacy' = single ciphertext payload */
  mode: 'fanout' | 'legacy'
}

export type SendResult =
  | { ok: true; message: ApiMessageRow }
  | { ok: false; error: string }

export type SendChatMessageTransportInput = {
  chat_id: string
  transport_mode: 'DIRECT' | 'SECTOR' | 'PUBLIC'
  plaintext?: string
  sender_private_key?: CryptoKey
  my_user_id?: string
  peer_user_id?: string
  content?: string | null
  iv?: string | null
  media_path?: string | null
  media_type?: string | null
  media_iv?: string | null
  reply_to_id?: string | null
  media_original_bytes?: number
  burn_at?: string | null
}

export type SendChatMessageTransportResult = {
  via: 'REST' | 'QUEUED'
  serverMessage?: ApiMessageRow
  outboxId?: string
}

/**
 * Send a message via REST fallback (when WS unavailable).
 * Automatically builds fan-out slots in 'fanout' mode.
 */
export async function sendMessageRest(opts: SendMessageOptions): Promise<SendResult> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    reply_to_id: opts.replyToId ?? null,
    media_path: opts.mediaPath ?? null,
    media_type: opts.mediaType ?? null,
    media_iv: opts.mediaIv ?? null,
    media_original_bytes: opts.mediaOriginalBytes,
    burn_at: opts.burnAt ?? null,
  }

  if (opts.mode === 'fanout') {
    if (!opts.senderPrivateKey || !opts.myUserId || !opts.peerUserId) {
      return { ok: false, error: 'FANOUT_MISSING_KEYS' }
    }
    const excludeDeviceId = getClientDeviceId() ?? undefined
    const ciphertexts = await buildFanoutSlots(
      opts.senderPrivateKey,
      opts.myUserId,
      opts.peerUserId,
      opts.plaintext,
      excludeDeviceId
    )
    if (ciphertexts.length === 0) {
      // Device registry unavailable or empty: keep a single-ciphertext fallback
      body.content = opts.content ?? null
      body.iv = opts.iv ?? null
    } else {
      body.ciphertexts = ciphertexts
    }
  } else {
    // Legacy mode: group_e2e or public_open
    body.content = opts.content ?? null
    body.iv = opts.iv ?? null
  }

  try {
    const res = await fetch(`${API_URL}/messages/send`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: err.error ?? 'SEND_FAILED' }
    }
    const data = (await res.json()) as { message: ApiMessageRow }
    return { ok: true, message: data.message }
  } catch {
    return { ok: false, error: 'NETWORK_ERROR' }
  }
}

async function postUnifiedSend(
  body: Record<string, unknown>
): Promise<{ ok: true; message: ApiMessageRow } | { ok: false; error: string; network: boolean }> {
  try {
    const res = await fetch(`${API_URL}/messages/send`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as {
      message?: ApiMessageRow
      error?: string
    }
    if (!res.ok || !data.message) {
      return { ok: false, error: data.error ?? 'SEND_FAILED', network: false }
    }
    return { ok: true, message: data.message }
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', network: true }
  }
}

export async function sendChatMessageOverTransport(
  input: SendChatMessageTransportInput
): Promise<SendChatMessageTransportResult> {
  const body: Record<string, unknown> = {
    chat_id: input.chat_id,
    content: input.content ?? null,
    iv: input.iv ?? null,
    media_path: input.media_path ?? null,
    media_type: input.media_type ?? null,
    media_iv: input.media_iv ?? null,
    reply_to_id: input.reply_to_id ?? null,
    media_original_bytes: input.media_original_bytes,
    burn_at: input.burn_at ?? null,
  }

  if (input.transport_mode === 'DIRECT') {
    if (!input.plaintext?.length) {
      throw new Error('DIRECT_PLAINTEXT_REQUIRED')
    }
    if (!input.sender_private_key || !input.my_user_id || !input.peer_user_id) {
      throw new Error('DIRECT_FANOUT_KEYS_REQUIRED')
    }

    const excludeDeviceId = getClientDeviceId() ?? undefined
    const ciphertexts = await buildFanoutSlots(
      input.sender_private_key,
      input.my_user_id,
      input.peer_user_id,
      input.plaintext,
      excludeDeviceId
    )
    if (ciphertexts.length === 0) {
      throw new Error('DIRECT_FANOUT_UNAVAILABLE')
    }
    body.ciphertexts = ciphertexts
    body.content = null
    body.iv = null
  }

  const sent = await postUnifiedSend(body)
  if (sent.ok) {
    return {
      via: 'REST',
      serverMessage: sent.message,
    }
  }

  if (sent.network) {
    const outboxId = await enqueueOutbox(body as SendChatMessageBody)
    void registerOutboxSync().catch(() => {
      /* best effort */
    })
    return { via: 'QUEUED', outboxId }
  }

  throw new Error(sent.error)
}

/**
 * Resolve per-device slot payload when provided by API.
 */
export function extractDeviceSlot(
  row: { device_ciphertext?: string | null; device_iv?: string | null }
): { ciphertext: string; iv: string } | null {
  if (row.device_ciphertext && row.device_iv) {
    return { ciphertext: row.device_ciphertext, iv: row.device_iv }
  }
  return null
}
