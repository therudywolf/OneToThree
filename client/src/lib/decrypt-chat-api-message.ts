import { decryptMessage } from '@/lib/crypto'
import {
  decryptInboundText,
  getAesKeyForChat,
  type ChatCryptoContext,
} from '@/lib/chat-crypto'
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
  read_at?: string | null
  burn_at?: string | null
  created_at: string
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
    burn_at: m.burn_at ?? null,
  }
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

/**
 * Decrypt many API rows with one ECDH derive + batched AES-GCM (worker for large backlogs).
 */
export async function decryptApiMessageRows(
  unwrappedPrivateKey: CryptoKey,
  cryptoCtx: ChatCryptoContext,
  rows: ApiMessageRow[]
): Promise<DecryptedMessage[]> {
  const jobs: { index: number; content: string; iv: string }[] = []
  rows.forEach((m, i) => {
    if (m.content != null && m.iv != null && m.content !== '') {
      jobs.push({ index: i, content: m.content, iv: m.iv })
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
  m: ApiMessageRow
): Promise<DecryptedMessage> {
  let plaintext = ''
  if (m.content != null && m.iv != null && m.content !== '') {
    try {
      plaintext = await decryptInboundText(
        unwrappedPrivateKey,
        cryptoCtx,
        m.content,
        m.iv
      )
    } catch {
      plaintext = '[DECRYPT_FAIL]'
    }
  }
  return apiRowToDecrypted(m, plaintext)
}
