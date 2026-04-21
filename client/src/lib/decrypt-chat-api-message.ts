import { decryptMessage } from '@/lib/crypto'
import {
  decryptInboundText,
  getAesKeyForChat,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { decryptFanoutSlot, DR_SLOT_SENTINEL } from '@/lib/fanout-crypto'
import {
  BATCH_WORKER_MIN,
  decryptTextBatchInWorker,
} from '@/lib/crypto-batch-worker'
import type { DecryptedMessage } from '@/types/chat'
import type { DrInitWirePayload } from '@/lib/ratchet/session-manager'

/** Validate and parse a server-supplied dr_init JSON string. Returns undefined
 *  on any structural mismatch so the caller skips the DR path rather than
 *  passing unvalidated data into cryptographic operations. */
function parseDrInitWirePayload(raw: string): DrInitWirePayload | undefined {
  try {
    const v = JSON.parse(raw)
    if (
      v === null ||
      typeof v !== 'object' ||
      v.p13 !== 'dr-init' ||
      v.v !== 1 ||
      typeof v.initiatorIdentityExchange !== 'string' || v.initiatorIdentityExchange.length === 0 ||
      typeof v.initiatorIdentitySigning !== 'string' || v.initiatorIdentitySigning.length === 0 ||
      typeof v.initiatorEphemeralPublic !== 'string' || v.initiatorEphemeralPublic.length === 0 ||
      typeof v.signedPrekeyId !== 'number' ||
      (v.oneTimePrekeyId !== null && typeof v.oneTimePrekeyId !== 'number')
    ) {
      return undefined
    }
    return v as DrInitWirePayload
  } catch {
    return undefined
  }
}

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
  media_original_bytes?: number | null
  device_ciphertext?: string | null
  device_iv?: string | null
  sender_ecdh_public_key_jwk?: string | null
  read_at?: string | null
  burn_at?: string | null
  is_pinned?: boolean
  reactions?: Record<string, string[]>
  created_at: string
  /** DR v2 fields */
  protocol_version?: 1 | 2 | null
  dr_header?: string | null
  dr_init?: string | null
}

function apiRowToDecrypted(
  m: ApiMessageRow,
  plaintext: string
): DecryptedMessage {
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
    media_original_bytes: m.media_original_bytes ?? null,
    burn_at: m.burn_at ?? null,
    is_pinned: m.is_pinned ?? false,
    reactions: m.reactions ?? {},
  }
}

type DrContext = { ownerUserId: string; peerUserId: string }

async function decryptJobsOnMain(
  aesKey: CryptoKey,
  jobs: { index: number; content: string; iv: string }[]
): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  for (const j of jobs) {
    try {
      map.set(j.index, await decryptMessage(aesKey, j.content, j.iv))
    } catch {
      map.set(j.index, '[DECRYPT_FAIL]')
    }
  }
  return map
}

async function decryptRowPlaintext(
  unwrappedPrivateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext,
  row: ApiMessageRow,
  drCtx?: DrContext
): Promise<string> {
  const c = row.device_ciphertext ?? row.content
  const iv = row.device_iv ?? row.iv
  if (c == null || iv == null || c === '') return ''

  // v2 DR: device slot carries the DR ciphertext directly (sentinel IV).
  if (
    row.protocol_version === 2 &&
    iv === DR_SLOT_SENTINEL &&
    row.dr_header &&
    drCtx
  ) {
    const { decryptFromPeer } = await import('@/lib/ratchet/session-manager')
    return decryptFromPeer(drCtx.ownerUserId, drCtx.peerUserId, {
      protocolVersion: 2,
      drHeader: row.dr_header,
      iv: DR_SLOT_SENTINEL,
      encrypted_content: c,
      drInit: row.dr_init ? parseDrInitWirePayload(row.dr_init) : undefined,
    })
  }

  // v1 fan-out: per-device ECDH slot (DIRECT and SELF both use fan-out delivery).
  if (
    (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') &&
    row.device_ciphertext &&
    row.device_iv &&
    row.sender_ecdh_public_key_jwk
  ) {
    return decryptFanoutSlot(
      unwrappedPrivateKey,
      row.sender_ecdh_public_key_jwk,
      row.device_ciphertext,
      row.device_iv
    )
  }

  return decryptInboundText(unwrappedPrivateKey, cryptoCtx, c, iv)
}

/**
 * Decrypt many API rows with one ECDH derive + batched AES-GCM (worker for large backlogs).
 * Pass `drCtx` for chats that may carry DR v2 messages.
 */
export async function decryptApiMessageRows(
  unwrappedPrivateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext,
  rows: ApiMessageRow[],
  drCtx?: DrContext
): Promise<DecryptedMessage[]> {
  if (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') {
    return Promise.all(
      rows.map(async (m) => {
        try {
          return apiRowToDecrypted(
            m,
            await decryptRowPlaintext(unwrappedPrivateKey, cryptoCtx, m, drCtx)
          )
        } catch {
          return apiRowToDecrypted(m, '[DECRYPT_FAIL]')
        }
      })
    )
  }

  const jobs: { index: number; content: string; iv: string }[] = []
  rows.forEach((m, i) => {
    const c = m.device_ciphertext ?? m.content
    const iv = m.device_iv ?? m.iv
    if (c != null && iv != null && c !== '') {
      jobs.push({ index: i, content: c, iv })
    }
  })
  if (jobs.length === 0) {
    return rows.map((m) => apiRowToDecrypted(m, ''))
  }

  let plaintextByIndex: Map<number, string>

  if (cryptoCtx.mode === 'PUBLIC') {
    plaintextByIndex = new Map(
      jobs.map((j) => {
        try {
          return [j.index, decodeURIComponent(escape(atob(j.content)))]
        } catch {
          return [j.index, j.content]
        }
      })
    )
  } else {
    const aesKey = await getAesKeyForChat(unwrappedPrivateKey, cryptoCtx)
    if (!aesKey) {
      return rows.map((m) => apiRowToDecrypted(m, ''))
    }

    const useWorker =
      jobs.length >= BATCH_WORKER_MIN &&
      typeof Worker !== 'undefined' &&
      typeof crypto !== 'undefined' &&
      typeof crypto.subtle?.exportKey === 'function'

    if (useWorker) {
      try {
        const keyRaw = await crypto.subtle.exportKey('raw', aesKey)
        const items = jobs.map((j) => ({
          ciphertextBase64: j.content,
          ivBase64: j.iv,
        }))
        const plaintexts = await decryptTextBatchInWorker(keyRaw, items)
        plaintextByIndex = new Map(
          jobs.map((j, k) => [j.index, plaintexts[k] ?? '[DECRYPT_FAIL]'])
        )
      } catch {
        plaintextByIndex = await decryptJobsOnMain(aesKey, jobs)
      }
    } else {
      plaintextByIndex = await decryptJobsOnMain(aesKey, jobs)
    }
  }

  return rows.map((m, i) =>
    apiRowToDecrypted(m, plaintextByIndex.get(i) ?? '')
  )
}

export async function decryptApiMessageRow(
  unwrappedPrivateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext,
  m: ApiMessageRow,
  drCtx?: DrContext
): Promise<DecryptedMessage> {
  let plaintext = ''
  if (
    (m.device_ciphertext != null && m.device_iv != null && m.device_ciphertext !== '') ||
    (m.content != null && m.iv != null && m.content !== '')
  ) {
    try {
      plaintext = await decryptRowPlaintext(unwrappedPrivateKey, cryptoCtx, m, drCtx)
    } catch {
      plaintext = '[DECRYPT_FAIL]'
    }
  }
  return apiRowToDecrypted(m, plaintext)
}

export type { DrContext }
