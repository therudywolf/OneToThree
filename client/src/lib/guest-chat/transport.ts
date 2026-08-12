// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

'use client'

/**
 * Guest temp-chat message transport — the guest half of the app's v1
 * per-device ECDH fan-out (lib/fanout-crypto.ts), with the guest's plain
 * in-memory CryptoKeys instead of the vault.
 *
 * Wire format (mirrors POST /api/messages/send + GET /api/messages/sync/pending
 * exactly, see server/src/routes/messages.ts):
 *   send    → { chat_id, content:null, iv:null, ciphertexts:[{device_id, ciphertext, iv}] }
 *             where iv is 'v2:' + base64(AES-GCM iv) and the AES key is
 *             HKDF-SHA-256(ECDH(myPriv, deviceEcdhPub)) — encryptFanoutDetailed.
 *   receive → rows carry device_ciphertext/device_iv addressed to OUR device
 *             plus sender_ecdh_public_key_jwk pinned at send time —
 *             decryptFanoutSlot.
 */

import { API_URL } from '@/lib/api/auth'
import { fetchWithTimeout } from '@/lib/api/fetch'
import { fetchChatDetail } from '@/lib/api/chats'
import {
  acknowledgeMessagesDelivered,
  fetchPendingDeliveries,
  markMessagesReadBatch,
  postSendChatMessage,
} from '@/lib/api/messages'
import type { ApiMessageRow } from '@/lib/decrypt-chat-api-message'
import {
  decryptFanoutSlot,
  encryptFanoutDetailed,
  fetchUserDevices,
  type DeviceSlot,
} from '@/lib/fanout-crypto'
import {
  exportEcdhPublicJwkFromPrivateKeyString,
  importEcdhPrivateKey,
} from '@/lib/crypto'
import type { GuestSessionState } from './session'

export type GuestChatContext = {
  chatId: string
  myUserId: string
  /** Server device row id (devices.id) for this tab's session. */
  myDeviceId: string
  hostUserId: string
  hostUsername: string
  /** Host's user-level ECDH key — decrypt fallback for unpinned rows. */
  hostEcdhPubJwk: string | null
  /** Guest ECDH private key (in-memory only). */
  ecdhPrivateKey: CryptoKey
  /** Guest ECDH public JWK (also decrypt key for our own echo slots). */
  myEcdhPubJwk: string
}

export type GuestChatMessage = {
  id: string
  mine: boolean
  text: string
  createdAt: string
  /** Decryption failed — rendered as a placeholder, never retried forever. */
  failed?: boolean
}

/**
 * Resolve the 1:1 chat: who is the host, and with which keys.
 * GET /api/chats/:chatId returns { chat, members[{user_id, username,
 * ecdh_public_key_jwk, ...}] } (server/src/routes/chats.ts).
 */
export async function bootstrapGuestChat(
  state: GuestSessionState,
  myDeviceId: string
): Promise<GuestChatContext> {
  const detail = await fetchChatDetail(state.chatId)
  const host = detail.members.find((m) => m.user_id !== state.userId)
  if (!host) throw new Error('CHAT_NOT_FOUND')
  const ecdhPrivateKey = await importEcdhPrivateKey(state.ecdhPrivJwk)
  const myEcdhPubJwk = exportEcdhPublicJwkFromPrivateKeyString(state.ecdhPrivJwk)
  return {
    chatId: state.chatId,
    myUserId: state.userId,
    myDeviceId,
    hostUserId: host.user_id,
    hostUsername: host.username,
    hostEcdhPubJwk: host.ecdh_public_key_jwk,
    ecdhPrivateKey,
    myEcdhPubJwk,
  }
}

/**
 * Decrypt one API row addressed to this guest device. Returns null for rows
 * that carry nothing this text-only client can render (media-only rows,
 * poll/system sentinels, rows without our device slot).
 */
async function decryptGuestRow(
  ctx: GuestChatContext,
  row: ApiMessageRow
): Promise<GuestChatMessage | null> {
  // Poll / system sentinel rows are plain JSON service payloads — skip.
  if (row.iv === 'poll:v1' || row.iv === 'system:v1') return null
  if (!row.device_ciphertext || !row.device_iv) return null

  const mine = row.sender_id === ctx.myUserId
  // Prefer the key pinned at send time; fall back to the party's user-level key.
  const senderKey =
    row.sender_ecdh_public_key_jwk ??
    (mine ? ctx.myEcdhPubJwk : ctx.hostEcdhPubJwk)
  if (!senderKey) return null

  try {
    const text = await decryptFanoutSlot(
      ctx.ecdhPrivateKey,
      senderKey,
      row.device_ciphertext,
      row.device_iv
    )
    return { id: row.id, mine, text, createdAt: row.created_at }
  } catch {
    return {
      id: row.id,
      mine,
      text: '',
      createdAt: row.created_at,
      failed: true,
    }
  }
}

/** GET /api/messages/:chatId → decrypt what is decryptable for OUR device. */
export async function fetchGuestHistory(
  ctx: GuestChatContext
): Promise<GuestChatMessage[]> {
  const res = await fetchWithTimeout(
    `${API_URL}/messages/${encodeURIComponent(ctx.chatId)}?limit=200`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as {
    messages?: ApiMessageRow[]
    error?: string
  }
  if (!res.ok) throw new Error(data.error ?? 'HISTORY_FAILED')
  const out: GuestChatMessage[] = []
  for (const row of data.messages ?? []) {
    const m = await decryptGuestRow(ctx, row)
    if (m) out.push(m)
  }
  return out
}

/**
 * Pull undelivered slots for our device, ack them, return the messages.
 * Mirrors use-chat-realtime's fan-out pending pull (content:null WS event →
 * GET /sync/pending → decrypt → POST /delivered).
 */
export async function pullGuestPending(
  ctx: GuestChatContext
): Promise<GuestChatMessage[]> {
  const rows = await fetchPendingDeliveries(ctx.chatId)
  const out: GuestChatMessage[] = []
  const ackIds: string[] = []
  for (const row of rows) {
    ackIds.push(row.id)
    const m = await decryptGuestRow(ctx, row)
    if (m) out.push(m)
  }
  if (ackIds.length > 0) {
    // Ack everything we pulled so /sync/pending never replays forever; a slot
    // we could not decrypt now will not become decryptable later (static keys).
    await acknowledgeMessagesDelivered(ackIds).catch(() => {})
  }
  return out
}

/** Best-effort read receipts for the host's messages (direct chat only). */
export function markGuestMessagesRead(ids: string[]): void {
  if (ids.length === 0) return
  void markMessagesReadBatch(ids).catch(() => {})
}

let cachedHostDevices: { at: number; devices: DeviceSlot[] } | null = null

async function hostDeviceSlots(ctx: GuestChatContext): Promise<DeviceSlot[]> {
  const now = Date.now()
  if (cachedHostDevices && now - cachedHostDevices.at < 30_000) {
    return cachedHostDevices.devices
  }
  const devices = await fetchUserDevices(ctx.hostUserId)
  cachedHostDevices = { at: now, devices }
  return devices
}

/**
 * Encrypt per-device fan-out slots (every host device + our own device as the
 * echo slot, same convention as buildFanoutSlotsDetailed which includes ALL
 * sender devices) and POST /api/messages/send. Returns the persisted row id +
 * timestamp for the optimistic bubble.
 */
export async function sendGuestMessage(
  ctx: GuestChatContext,
  plaintext: string
): Promise<{ id: string; createdAt: string }> {
  const hostDevices = await hostDeviceSlots(ctx)

  // Own echo slot: our device row has no server-side ECDH key (guests cannot
  // PATCH /users/me), so it never appears in GET /users/:id/devices — add it
  // manually, encrypted to our own public key. This is what lets history
  // rows we sent decrypt again after a reload of the same tab.
  const targets = new Map<string, DeviceSlot>()
  for (const d of hostDevices) targets.set(d.device_id, d)
  if (!targets.has(ctx.myDeviceId)) {
    targets.set(ctx.myDeviceId, {
      device_id: ctx.myDeviceId,
      ecdh_public_key: ctx.myEcdhPubJwk,
    })
  }

  const { slots } = await encryptFanoutDetailed(
    ctx.ecdhPrivateKey,
    [...targets.values()],
    plaintext
  )
  if (slots.length === 0) throw new Error('FANOUT_UNAVAILABLE')

  const row = await postSendChatMessage({
    chat_id: ctx.chatId,
    content: null,
    iv: null,
    ciphertexts: slots,
  })
  return { id: row.id, createdAt: row.created_at }
}
