/**
 * Session store — IndexedDB-backed persistence for Double Ratchet state.
 *
 * One record per (ownerUserId, peerUserId) tuple. Values are serialized to
 * JSON with base64url for binary fields. Ratchet state contains secret
 * material, so all records are wrapped with AES-GCM using a key derived
 * from the user's vault — see `@/lib/vault`. That glue lives in phase 3.3.
 *
 * This file only provides the raw K/V layer; callers encrypt/decrypt at the
 * boundary so this module never touches plaintext key bytes.
 */
const DB_NAME = 'forest-ratchet'
const DB_VERSION = 1
const STORE = 'sessions'

export interface StoredSessionRecord {
  id: string
  peerUserId: string
  payload: ArrayBuffer
  updatedAt: number
  /** Protocol version so we can migrate if the ratchet schema evolves. */
  protocolVersion: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('peer', 'peerUserId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('RATCHET_DB_OPEN_FAILED'))
  })
}

function recordId(ownerId: string, peerId: string): string {
  return `${ownerId}::${peerId}`
}

export async function putSessionRecord(
  ownerId: string,
  peerId: string,
  encryptedPayload: ArrayBuffer,
  protocolVersion: number
): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({
      id: recordId(ownerId, peerId),
      peerUserId: peerId,
      payload: encryptedPayload,
      updatedAt: Date.now(),
      protocolVersion,
    } satisfies StoredSessionRecord)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('RATCHET_DB_TX_FAILED'))
  })
  db.close()
}

export async function getSessionRecord(
  ownerId: string,
  peerId: string
): Promise<StoredSessionRecord | null> {
  const db = await openDb()
  const result = await new Promise<StoredSessionRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(recordId(ownerId, peerId))
    req.onsuccess = () => resolve((req.result as StoredSessionRecord) ?? null)
    req.onerror = () => reject(req.error ?? new Error('RATCHET_DB_GET_FAILED'))
  })
  db.close()
  return result
}

export async function deleteSessionRecord(
  ownerId: string,
  peerId: string
): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(recordId(ownerId, peerId))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('RATCHET_DB_DELETE_FAILED'))
  })
  db.close()
}

export async function listSessionPeers(ownerId: string): Promise<string[]> {
  const db = await openDb()
  const peers = await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    const out: string[] = []
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve(out)
        return
      }
      const r = cursor.value as StoredSessionRecord
      if (r.id.startsWith(`${ownerId}::`)) out.push(r.peerUserId)
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('RATCHET_DB_LIST_FAILED'))
  })
  db.close()
  return peers
}
