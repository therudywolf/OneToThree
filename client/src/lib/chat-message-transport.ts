'use client'

/**
 * Stage 5 :: CHAT MESSAGE TRANSPORT
 * Handles both legacy (single ciphertext) and fan-out (per-device) modes.
 */

import { API_URL } from '@/lib/api/auth'
import { buildFanoutSlots } from './fanout-crypto'
import { getClientDeviceId } from './client-device'
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
  /** 'fanout' = Stage 5 per-device, 'legacy' = single ciphertext */
  mode: 'fanout' | 'legacy'
}

export type SendResult =
  | { ok: true; message: ApiMessageRow }
  | { ok: false; error: string }

export type SendChatMessageTransportInput = {
  chat_id: string
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
      // No linked devices found; fall back to legacy single-ciphertext
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

/**
 * Current transport dispatcher.
 * For now we route through the REST send contract so hooks have one stable path.
 * This keeps message sending alive while WS/outbox transport is being rebuilt.
 */
export async function sendChatMessageOverTransport(
  input: SendChatMessageTransportInput
): Promise<SendChatMessageTransportResult> {
  const result = await sendMessageRest({
    chatId: input.chat_id,
    plaintext: '',
    content: input.content ?? null,
    iv: input.iv ?? null,
    mediaPath: input.media_path ?? null,
    mediaType: input.media_type ?? null,
    mediaIv: input.media_iv ?? null,
    replyToId: input.reply_to_id ?? null,
    mediaOriginalBytes: input.media_original_bytes,
    burnAt: input.burn_at ?? null,
    mode: 'legacy',
  })

  if (!result.ok) {
    throw new Error(result.error)
  }

  return {
    via: 'REST',
    serverMessage: result.message,
  }
}

/**
 * Resolve the device_ciphertext from a pending sync row for the current device.
 * Returns null if the message has no fan-out slot for this device (legacy row or
 * this device wasn't in the recipient list).
 */
export function extractDeviceSlot(
  row: { device_ciphertext?: string | null; device_iv?: string | null }
): { ciphertext: string; iv: string } | null {
  if (row.device_ciphertext && row.device_iv) {
    return { ciphertext: row.device_ciphertext, iv: row.device_iv }
  }
  return null
}
