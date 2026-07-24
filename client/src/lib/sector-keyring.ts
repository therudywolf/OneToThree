// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * SECTOR per-epoch key ring (#32 / #33 — backward secrecy + history retention).
 *
 * The original group-key design (group-key-rotation.ts, owner decision
 * 2026-05-30) kept NO client key history: after any rotation, every member's
 * SECTOR context was rebuilt from the server's SINGLE current wrapped blob, so
 * messages sealed under a prior key stopped decrypting for EVERYONE. That made
 * rotation-on-add impossible (adding a member would wipe the whole group's
 * history) and denied backward secrecy no matter what.
 *
 * This ring lifts that limit WITHOUT changing the wire format or adding a
 * server migration. Each time a member receives a wrapped SECTOR key (creation,
 * rotation, or an add-triggered rekey), the blob is appended here — keyed by its
 * epoch, which `readStoredSectorKeyEpoch` reads WITHOUT unwrapping. Decryption
 * then tries every retained key (newest epoch first), so:
 *
 *   - Existing members keep reading their whole history across rotations
 *     (the UX win — a departure or an add no longer erases the backlog).
 *   - A NEWLY added member's ring starts with ONLY the current epoch, because
 *     the older blobs were sealed to the OTHER members and were never on the
 *     server for the newcomer to receive — so it cannot read pre-join history
 *     (the backward-secrecy win, #32).
 *   - A departed member never receives the post-departure epoch, so it still
 *     cannot read new traffic (forward secrecy, unchanged).
 *
 * At-rest safety: the stored value is the SAME `CREATOR_AUTH_WRAP` blob the
 * server already holds — sealed to this member's ECDH key, opened only with the
 * vault private key. Persisting it locally is not a new exposure; it is a copy
 * of a blob the server keeps too. No extra wrap key is needed.
 *
 * Bounded: only the most-recent {@link RING_CAP} epochs are retained per chat.
 * A pre-cap epoch's messages become unreadable again — an accepted, far-back
 * limit, not a regression (that history was already at risk under the old
 * design, which kept zero epochs).
 */

const DB_NAME = 'forest-sector-keys'
const DB_VERSION = 1
const STORE = 'rings'

/** Max retained epochs per (owner, chat). Groups rotate on membership changes,
 *  not per-message, so this covers a long tail of real rotations. */
export const RING_CAP = 16

/** One retained wrapped SECTOR key: the server blob plus its parsed epoch. */
export interface RingEntry {
  epoch: number
  /** base64 `CREATOR_AUTH_WRAP` payload — the exact server-stored blob. */
  wrapped: string
}

interface StoredRing {
  id: string
  ownerUserId: string
  chatId: string
  entries: RingEntry[]
  updatedAt: number
}

function ringId(ownerId: string, chatId: string): string {
  // owner/chat ids are uuids/opaque and never contain `::`.
  return `${ownerId}::${chatId}`
}

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('SECTOR_RING_DB_OPEN_FAILED'))
  })
}

async function readRing(ownerId: string, chatId: string): Promise<StoredRing | null> {
  const db = await openDb()
  try {
    return await new Promise<StoredRing | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(ringId(ownerId, chatId))
      req.onsuccess = () => resolve((req.result as StoredRing) ?? null)
      req.onerror = () => reject(req.error ?? new Error('SECTOR_RING_GET_FAILED'))
    })
  } finally {
    db.close()
  }
}

/**
 * Return the retained wrapped keys for a chat, NEWEST epoch first. Callers
 * unwrap each with the member's private key and try them in order on decrypt.
 * Never throws — a storage failure degrades to "no history" (the caller still
 * has the live server key), not a crash.
 */
export async function getRingEntries(ownerId: string, chatId: string): Promise<RingEntry[]> {
  if (!idbAvailable()) return []
  try {
    const ring = await readRing(ownerId, chatId)
    if (!ring) return []
    return [...ring.entries].sort((a, b) => b.epoch - a.epoch)
  } catch {
    return []
  }
}

/**
 * Append a wrapped SECTOR key to the ring. Idempotent per epoch: a blob for an
 * epoch already present is ignored (the first one seen wins — they wrap the same
 * key material). Keeps only the newest {@link RING_CAP} epochs. Never throws.
 */
export async function addRingEntry(
  ownerId: string,
  chatId: string,
  epoch: number,
  wrapped: string
): Promise<void> {
  if (!idbAvailable()) return
  try {
    const existing = (await readRing(ownerId, chatId))?.entries ?? []
    if (existing.some((e) => e.epoch === epoch)) return
    const merged = [...existing, { epoch, wrapped }]
      .sort((a, b) => b.epoch - a.epoch)
      .slice(0, RING_CAP)
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put({
          id: ringId(ownerId, chatId),
          ownerUserId: ownerId,
          chatId,
          entries: merged,
          updatedAt: Date.now(),
        } satisfies StoredRing)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('SECTOR_RING_PUT_FAILED'))
      })
    } finally {
      db.close()
    }
  } catch {
    // Best-effort: losing a ring append only costs history retention for that
    // one epoch; the live server key still decrypts current traffic.
  }
}

/** Forget a chat's ring (e.g. on leave / TOFU reset). Never throws. */
export async function clearRing(ownerId: string, chatId: string): Promise<void> {
  if (!idbAvailable()) return
  try {
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(ringId(ownerId, chatId))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('SECTOR_RING_DELETE_FAILED'))
      })
    } finally {
      db.close()
    }
  } catch {
    /* ignore */
  }
}
