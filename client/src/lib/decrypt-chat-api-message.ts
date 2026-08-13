import { decryptMessage } from '@/lib/crypto'
import {
  decryptInboundText,
  getAesKeyRingForChat,
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
  reply_to_sender_id?: string | null
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
    reply_to_sender_id: m.reply_to_sender_id ?? null,
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
    const { decryptFromPeer, whenDrIdentityReady } = await import(
      '@/lib/ratchet/session-manager'
    )
    // Opening a chat on a cold load races vault activation, which installs the
    // DR identity only at the very end. Losing that race threw
    // RATCHET_IDENTITY_NOT_READY, the row rendered as "[DECRYPT_FAIL]", and
    // nothing ever retried it — so the FIRST message from a new contact stayed
    // permanently unreadable. Wait for the identity instead. Gating here rather
    // than in each hook covers every reader: history load, realtime, pending
    // sync. Already-ready is the overwhelmingly common case and costs nothing.
    await whenDrIdentityReady()
    // A row from one of the user's OWN devices is a self-sync copy: it rode
    // the (ownDevice <-> ownOtherDevice) ratchet, so its DR peer is the user
    // themselves. Routing it to the chat peer looks up a ratchet that does not
    // exist, so the copy never decrypts on the user's other devices.
    const drPeerUserId =
      row.sender_id === drCtx.ownerUserId ? drCtx.ownerUserId : drCtx.peerUserId
    return decryptFromPeer(drCtx.ownerUserId, drPeerUserId, drEnv)
  }

  // A v2 row we simply cannot route yet: the chat list hasn't resolved the peer
  // user id, so there is no `drCtx`. Distinct from the downgrade rejection
  // below — this row IS Double Ratchet, and the caller re-runs once the peer
  // resolves. Calling it a v1 downgrade attempt sent anyone reading the logs
  // hunting a protocol attack that never happened.
  if (row.protocol_version === 2 && iv === DR_SLOT_SENTINEL && !drCtx) {
    throw new Error('ERR_DR_PEER_UNRESOLVED')
  }

  // DIRECT conversations are Double Ratchet (v2) ONLY. Reaching here for a
  // DIRECT chat means the row is not a valid v2 envelope — a v1
  // protocol-downgrade attempt or a malformed row. The v1 static-ECDH path
  // derives its key from a server-supplied sender key and is not
  // sender-authenticated; never fall through to it for a DIRECT chat.
  //
  // The ONE sanctioned exception: a server-marked temp-chat GUEST peer
  // (ChatCryptoContext.peerIsGuest). Guests cannot run the Double Ratchet —
  // no vault, no X3DH bundle — so their chats ride v1 fan-out by design, and
  // the flag comes from the server-assigned user_group, never from the row.
  const directGuestV1 = cryptoCtx.mode === 'DIRECT' && cryptoCtx.peerIsGuest === true
  if (cryptoCtx.mode === 'DIRECT' && !directGuestV1) {
    throw new Error('ERR_DIRECT_V1_REJECTED')
  }

  // Temp-chat guest fan-out slot: decrypt with ECDH(myPriv, senderPub) where
  // the sender key is the row-pinned one, falling back to the peer's (or my
  // own, for self-echo rows from my other devices) user-level key.
  if (directGuestV1 && row.device_ciphertext && row.device_iv) {
    const isOwnRow = hints?.myUserId != null && row.sender_id === hints.myUserId
    const candidates: string[] = []
    const pushUnique = (k: string | null | undefined) => {
      if (k && !candidates.includes(k)) candidates.push(k)
    }
    pushUnique(row.sender_ecdh_public_key_jwk)
    if (cryptoCtx.mode === 'DIRECT') pushUnique(cryptoCtx.peerPublicKeyJwk)
    if (isOwnRow) pushUnique(hints?.myEcdhPublicKeyJwk)
    hints?.priorPeerEcdhPublicKeysJwk?.forEach(pushUnique)
    let lastGuestErr: unknown
    for (const key of candidates) {
      try {
        return await decryptFanoutSlot(
          unwrappedPrivateKey,
          key,
          row.device_ciphertext,
          row.device_iv
        )
      } catch (err) {
        lastGuestErr = err
      }
    }
    throw lastGuestErr ?? new Error('FANOUT_DECRYPT_NO_CANDIDATE')
  }

  // v1 fan-out: per-device ECDH slot. DIRECT v1 is handled above, so this
  // path is SELF-only — Saved Messages self-fanout slots. The sender is always
  // the user themselves; the candidate list covers ECDH key rotation (the
  // server may still return an old pinned jwk after a vault key change).
  if (cryptoCtx.mode === 'SELF' && row.device_ciphertext && row.device_iv) {
    // Prefer the just-unlocked vault key over the server-cached value.
    const fallbackKey = hints?.myEcdhPublicKeyJwk ?? cryptoCtx.selfPublicKeyJwk
    const senderKey = row.sender_ecdh_public_key_jwk ?? fallbackKey

    // M-04: verify a server-pinned sender key against the trust store before
    // use. Fallback keys come from the local vault and are pre-vetted.
    if (row.sender_ecdh_public_key_jwk) {
      const keyBytes = new TextEncoder().encode(row.sender_ecdh_public_key_jwk)
      const digest = sha256(keyBytes)
      const fingerprint = 'sha256:' + Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('')
      const trustStatus = resolveTrustStatus(row.sender_id, fingerprint)
      if (trustStatus.revokedByKeyChange) {
        // Key has changed since last pin — abort decryption to prevent MitM.
        return '[KEY_CHANGE_DETECTED]'
      }
    }

    const candidates: string[] = [senderKey]
    const pushUnique = (k: string | null | undefined) => {
      if (k && !candidates.includes(k)) candidates.push(k)
    }
    pushUnique(cryptoCtx.selfPublicKeyJwk)
    pushUnique(hints?.myEcdhPublicKeyJwk)
    hints?.priorMyEcdhPublicKeysJwk?.forEach(pushUnique)

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
    if (typeof console !== 'undefined') {
      console.warn('[fanout] SELF slot decrypt failed across all candidate keys', {
        messageId: row.id,
        chatId: row.chat_id,
        candidateCount: candidates.length,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      })
    }
    throw lastErr ?? new Error('FANOUT_DECRYPT_NO_CANDIDATE')
  }

  return decryptInboundText(unwrappedPrivateKey, cryptoCtx, c, iv)
}

/**
 * A failed decrypt used to be COMPLETELY silent — `catch {}` turned every
 * cause into the same "[DECRYPT_FAIL]" bubble. That is the one piece of
 * information needed to tell a transient DR-session race apart from a real
 * key mismatch, and its absence is why a first-message failure could survive
 * unnoticed. Logs the reason only: never key material, never plaintext.
 */
function noteDecryptFailure(row: ApiMessageRow, err: unknown): void {
  // WebCrypto throws `OperationError` with an EMPTY message on a failed AES-GCM
  // auth tag — the single most likely failure here — so fall back to the name.
  const reason =
    err instanceof Error ? err.message || err.name || 'Error' : String(err)
  console.warn('[dr] message decrypt failed', {
    id: row.id,
    pv: row.protocol_version ?? null,
    iv: row.device_iv ?? row.iv ?? null,
    reason,
  })
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
        } catch (err) {
          noteDecryptFailure(m, err)
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
          // Malformed base64 (server bug) — surface a decode marker instead of
          // rendering the raw base64 blob, matching the single-row path.
          return [j.index, '[DECRYPT_FAIL]']
        }
      })
    )
  } else {
    // #32 per-epoch ring: [0] is the current key (the fast path — worker/main,
    // byte-identical to before); [1..] are retained older-epoch keys used only
    // to re-open rows the current key couldn't (post-rotation history).
    const ring = await getAesKeyRingForChat(unwrappedPrivateKey, cryptoCtx)
    if (!ring || ring.length === 0) {
      return rows.map((m) => apiRowToDecrypted(m, ''))
    }
    const aesKey = ring[0]

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

    // Ring fallback: any row the current key failed on may be an older epoch.
    // Retry just those against each retained key, newest→oldest, on the main
    // thread (the failed set is normally empty, so this costs nothing).
    if (ring.length > 1) {
      let pending = jobs.filter((j) => plaintextByIndex.get(j.index) === '[DECRYPT_FAIL]')
      for (let k = 1; k < ring.length && pending.length > 0; k += 1) {
        const retried = await decryptJobsOnMain(ring[k], pending)
        for (const j of pending) {
          const v = retried.get(j.index)
          if (v !== undefined && v !== '[DECRYPT_FAIL]') plaintextByIndex.set(j.index, v)
        }
        pending = pending.filter((j) => plaintextByIndex.get(j.index) === '[DECRYPT_FAIL]')
      }
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
    } catch (err) {
      noteDecryptFailure(m, err)
      plaintext = '[DECRYPT_FAIL]'
    }
  }
  return apiRowToDecrypted(m, plaintext)
}

export type { DrContext }
