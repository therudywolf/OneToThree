import { decryptMessage } from '@/lib/crypto'
import {
  decryptInboundText,
  getAesKeyForChat,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
import { decryptFanoutSlot, DR_SLOT_SENTINEL } from '@/lib/fanout-crypto'
import { parseDrDeviceEnvelope } from '@/lib/dr-envelope'
import { resolveTrustStatus } from '@/lib/trust-store'
import { sha256 } from '@noble/hashes/sha2'
import {
  BATCH_WORKER_MIN,
  decryptTextBatchInWorker,
} from '@/lib/crypto-batch-worker'
import type { DecryptedMessage } from '@/types/chat'

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
  burn_duration_secs?: number | null
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
  // Parse system:v1 messages to expose kind/kindMeta
  let kind: string | undefined
  let kindMeta: Record<string, unknown> | undefined
  if (m.iv === 'system:v1' && plaintext) {
    try {
      const parsed = JSON.parse(plaintext) as Record<string, unknown>
      kind = typeof parsed.kind === 'string' ? parsed.kind : undefined
      kindMeta = parsed
    } catch { /* not JSON — ignore */ }
  }
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
    burn_duration_secs: m.burn_duration_secs ?? null,
    is_pinned: m.is_pinned ?? false,
    reactions: m.reactions ?? {},
    ...(kind !== undefined ? { kind, kindMeta } : {}),
  }
}

type DrContext = { ownerUserId: string; peerUserId: string }

/**
 * Optional hints used to choose the correct ECDH peer key for legacy DIRECT
 * messages whose `sender_ecdh_public_key_jwk` was not pinned at send time
 * (pre-migration 0043). Without these the fallback path always used the
 * peer key, which made every self-sent legacy slot fail to decrypt.
 */
export type DecryptHints = {
  myUserId?: string
  myEcdhPublicKeyJwk?: string | null
  /**
   * Historical public ECDH JWKs this client has used in the past (newest
   * first). When the active ECDH key has rotated, the receiver's vault still
   * contains the same private key but old messages may have been encrypted
   * with an earlier device-side public key. The decrypt fallback walks this
   * list to recover those rows.
   */
  priorMyEcdhPublicKeysJwk?: string[]
  /** Historical peer ECDH JWKs (same intent, but for the other party). */
  priorPeerEcdhPublicKeysJwk?: string[]
}

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
  drCtx?: DrContext,
  hints?: DecryptHints
): Promise<string> {
  const c = row.device_ciphertext ?? row.content
  const iv = row.device_iv ?? row.iv
  if (c == null || iv == null || c === '') return ''

  // Poll sentinel: content is plain JSON, no encryption needed.
  if (iv === 'poll:v1') return c

  // System message sentinel: content is plain JSON (missed call, etc.).
  if (iv === 'system:v1') return c ?? ''

  // v2 DR: the device slot carries a self-describing per-device envelope
  // (DrDeviceEnvelope JSON) in the slot ciphertext — the envelope holds the
  // DR header, ciphertext, sender device id and (first message) the X3DH
  // init. There is no shared `dr_header` on the message row for v2.
  if (
    row.protocol_version === 2 &&
    iv === DR_SLOT_SENTINEL &&
    drCtx
  ) {
    const drEnv = parseDrDeviceEnvelope(c)
    if (!drEnv) throw new Error('ERR_DR_ENVELOPE_INVALID')
    const { decryptFromPeer } = await import('@/lib/ratchet/session-manager')
    // A self-sync copy — a row whose sender is one of MY OWN devices — rides the
    // ratchet (myDeviceA <-> myDeviceB), so its DR peer is my own account, not
    // the chat peer. `decryptFromPeer` routes to (owner, thisDevice, peer,
    // envelope.sd); passing the chat peer for a self-sync row finds no session
    // and aborts with X3DH_IDENTITY_MISMATCH. A batch can mix peer messages and
    // self-sync rows, so the DR peer is chosen per row.
    const drPeerId =
      row.sender_id === drCtx.ownerUserId ? drCtx.ownerUserId : drCtx.peerUserId
    return decryptFromPeer(drCtx.ownerUserId, drPeerId, drEnv)
  }

  // v1 fan-out: per-device ECDH slot (DIRECT and SELF both use fan-out delivery).
  // For messages sent after migration 0043 the sender key is pinned in the DB row.
  // For older messages (sender_ecdh_public_key_jwk = null) the correct fallback
  // depends on who sent the message:
  //   - sender is me  → use MY public key (self-fanout slot was encrypted with
  //                     ECDH(myPriv, myPub); decrypt needs myPub on the public side)
  //   - sender is peer → use peer public key
  // Without sender-aware selection, every self-sent legacy slot decrypted with
  // the peer key, producing [DECRYPT_FAIL] on every page reload.
  if (
    (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') &&
    row.device_ciphertext &&
    row.device_iv
  ) {
    let fallbackKey: string
    if (cryptoCtx.mode === 'SELF') {
      // Prefer the just-unlocked vault key over the server-cached value.
      // After an ECDH key rotation, server may still return the old jwk in
      // chat members; the hint always matches the private key in memory.
      fallbackKey = hints?.myEcdhPublicKeyJwk ?? cryptoCtx.selfPublicKeyJwk
    } else if (
      hints?.myUserId &&
      hints?.myEcdhPublicKeyJwk &&
      row.sender_id === hints.myUserId
    ) {
      fallbackKey = hints.myEcdhPublicKeyJwk
    } else {
      fallbackKey = cryptoCtx.peerPublicKeyJwk
    }
    // Build the ordered candidate list of "sender public keys" to try. The
    // first one is the best guess (pinned-or-fallback). Subsequent entries
    // cover key-rotation edge cases on either side. Walking the list with a
    // single try/catch keeps the rotation safety net uniform across SELF and
    // DIRECT modes.
    const senderKey = row.sender_ecdh_public_key_jwk ?? fallbackKey

    // M-04: verify sender_ecdh_public_key_jwk against trust store before
    // decryption. Only the pinned (server-supplied) key is checked — fallback
    // keys from hints are pre-vetted by the local vault.
    if (row.sender_ecdh_public_key_jwk) {
      const keyBytes = new TextEncoder().encode(row.sender_ecdh_public_key_jwk)
      const digest = sha256(keyBytes)
      const fingerprint = 'sha256:' + Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('')
      const trustStatus = resolveTrustStatus(row.sender_id, fingerprint)
      if (trustStatus.revokedByKeyChange) {
        // Key has changed since last pin — abort decryption to prevent MitM.
        return '[KEY_CHANGE_DETECTED]'
      }
      // TOFU: !trustStatus.is_verified is expected on first encounter;
      // the trust-store write path pins on explicit user verification.
    }

    const candidates: string[] = [senderKey]
    const pushUnique = (k: string | null | undefined) => {
      if (k && !candidates.includes(k)) candidates.push(k)
    }
    if (cryptoCtx.mode === 'DIRECT') {
      pushUnique(cryptoCtx.peerPublicKeyJwk)
      pushUnique(hints?.myEcdhPublicKeyJwk)
      hints?.priorMyEcdhPublicKeysJwk?.forEach(pushUnique)
      hints?.priorPeerEcdhPublicKeysJwk?.forEach(pushUnique)
    } else if (cryptoCtx.mode === 'SELF') {
      pushUnique(cryptoCtx.selfPublicKeyJwk)
      pushUnique(hints?.myEcdhPublicKeyJwk)
      hints?.priorMyEcdhPublicKeysJwk?.forEach(pushUnique)
    }

    let lastErr: unknown
    for (const key of candidates) {
      try {
        return await decryptFanoutSlot(
          unwrappedPrivateKey,
          key,
          row.device_ciphertext,
          row.device_iv
        )
      } catch (err) {
        lastErr = err
      }
    }
    // All candidate ECDH public keys failed. Emit a single diagnostic so a
    // surge of [DECRYPT_FAIL] rows is visible in the console instead of being
    // silently swallowed by the row-level try/catch in decryptApiMessageRows.
    if (typeof console !== 'undefined') {
      console.warn(
        '[fanout] decrypt failed across all candidate keys',
        {
          messageId: row.id,
          chatId: row.chat_id,
          senderId: row.sender_id,
          candidateCount: candidates.length,
          pinned: Boolean(row.sender_ecdh_public_key_jwk),
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        }
      )
    }
    throw lastErr ?? new Error('FANOUT_DECRYPT_NO_CANDIDATE')
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
  drCtx?: DrContext,
  hints?: DecryptHints
): Promise<DecryptedMessage[]> {
  if (cryptoCtx.mode === 'DIRECT' || cryptoCtx.mode === 'SELF') {
    return Promise.all(
      rows.map(async (m) => {
        try {
          return apiRowToDecrypted(
            m,
            await decryptRowPlaintext(unwrappedPrivateKey, cryptoCtx, m, drCtx, hints)
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
  drCtx?: DrContext,
  hints?: DecryptHints
): Promise<DecryptedMessage> {
  let plaintext = ''
  if (
    (m.device_ciphertext != null && m.device_iv != null && m.device_ciphertext !== '') ||
    (m.content != null && m.iv != null && m.content !== '')
  ) {
    try {
      plaintext = await decryptRowPlaintext(unwrappedPrivateKey, cryptoCtx, m, drCtx, hints)
    } catch {
      plaintext = '[DECRYPT_FAIL]'
    }
  }
  return apiRowToDecrypted(m, plaintext)
}

export type { DrContext }
