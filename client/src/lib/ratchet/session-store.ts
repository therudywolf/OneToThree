/**
 * Session store — IndexedDB-backed persistence for Double Ratchet state.
 *
 * One record per (ownerUserId, ownDeviceId, peerUserId, peerDeviceId) tuple
 * — track A4 makes the ratchet per-device, so a single (owner, peer) pair may
 * hold several concurrent ratchets, one for every linked device on each side.
 * Values are serialized to JSON with base64url for binary fields. Ratchet
 * state contains secret material, so all records are wrapped with AES-GCM
 * using a key derived from the user's vault — see `@/lib/vault`. That glue
 * lives in phase 3.3.
 *
 * This file only provides the raw K/V layer; callers encrypt/decrypt at the
 * boundary so this module never touches plaintext key bytes.
 *
 * DB_VERSION history:
 *   1 — single (owner, peer) record id, no device dimension.
 *   2 — per-device records keyed by the 4-tuple above. The v1 store is
 *       dropped on upgrade; sessions re-bootstrap transparently on next send.
 */
const DB_NAME = 'forest-ratchet'
const DB_VERSION = 2
const STORE = 'sessions'

export interface StoredSessionRecord {
  id: string
  /** Owner user id — kept for the legacy ownership prefix scan. */
  ownerUserId: string
  /** Owner's own device id (sender-side device dimension). */
  ownDeviceId: string
  peerUserId: string
  /** Peer device id this ratchet talks to (receiver-side device dimension). */
  peerDeviceId: string
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
      // v1 → v2 keyed the records by (owner, peer) only; the payloads are not
      // forward-compatible with per-device routing, so drop the old store
      // outright. Sessions re-bootstrap on the next outbound message.
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE)
      }
      const store = db.createObjectStore(STORE, { keyPath: 'id' })
      // Index on the (owner, peer) pair so callers can enumerate every
      // per-device ratchet for a conversation without a full table scan.
      store.createIndex('peer', 'peerUserId', { unique: false })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('RATCHET_DB_OPEN_FAILED'))
  })
}

/**
 * Build the composite record id. Device ids are uuids/opaque strings and
 * never contain `::`, so the join is unambiguous.
 */
function recordId(
  ownerId: string,
  ownDeviceId: string,
  peerId: string,
  peerDeviceId: string
): string {
  return `${ownerId}::${ownDeviceId}::${peerId}::${peerDeviceId}`
}

export async function putSessionRecord(
  ownerId: string,
  ownDeviceId: string,
  peerId: string,
  peerDeviceId: string,
  encryptedPayload: ArrayBuffer,
  protocolVersion: number
): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({
      id: recordId(ownerId, ownDeviceId, peerId, peerDeviceId),
      ownerUserId: ownerId,
      ownDeviceId,
      peerUserId: peerId,
      peerDeviceId,
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
  ownDeviceId: string,
  peerId: string,
  peerDeviceId: string
): Promise<StoredSessionRecord | null> {
  const db = await openDb()
  const result = await new Promise<StoredSessionRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(recordId(ownerId, ownDeviceId, peerId, peerDeviceId))
    req.onsuccess = () => resolve((req.result as StoredSessionRecord) ?? null)
    req.onerror = () => reject(req.error ?? new Error('RATCHET_DB_GET_FAILED'))
  })
  db.close()
  return result
}

export async function deleteSessionRecord(
  ownerId: string,
  ownDeviceId: string,
  peerId: string,
  peerDeviceId: string
): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(recordId(ownerId, ownDeviceId, peerId, peerDeviceId))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('RATCHET_DB_DELETE_FAILED'))
  })
  db.close()
}

/**
 * Delete every per-device ratchet record for a (owner, peer) conversation —
 * used by the TOFU reset path where the peer's whole identity changed.
 */
export async function deleteSessionRecordsForPeer(
  ownerId: string,
  peerId: string
): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const r = cursor.value as StoredSessionRecord
      if (r.ownerUserId === ownerId && r.peerUserId === peerId) {
        cursor.delete()
      }
      cursor.continue()
    }
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
    const out = new Set<string>()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve([...out])
        return
      }
      const r = cursor.value as StoredSessionRecord
      if (r.ownerUserId === ownerId) out.add(r.peerUserId)
      cursor.continue()
    }
    req.onerror = () => reject(req.error ?? new Error('RATCHET_DB_LIST_FAILED'))
  })
  db.close()
  return peers
}
