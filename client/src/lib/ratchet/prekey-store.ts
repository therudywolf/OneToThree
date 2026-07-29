// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Local storage for RANDOM X3DH prekey private keys.
 *
 * Why this exists
 * ---------------
 * The signed prekey and every one-time prekey used to be HKDF expansions of the
 * vault's ECDH scalar (`identity-from-vault.ts` → `spkSeed`, `deriveOtpPrivKey`).
 * That made them re-derivable — convenient, and a complete forfeit of the
 * property X3DH exists to provide: whoever later obtains the vault can recompute
 * every prekey private key and therefore recover the X3DH shared secret of every
 * session ever established, including ones whose ciphertext they captured months
 * earlier. The "one-time" prekeys contributed no forward secrecy at all, because
 * they were a deterministic function of a long-term secret.
 *
 * Random prekeys have to live somewhere, so they live here: generated once,
 * private half kept locally, public half published. The DR identity keys stay
 * derived from the vault on purpose — an identity is *supposed* to be long-term
 * and stable, and it is what the safety number certifies.
 *
 * Scope
 * -----
 * Keyed by (userId, deviceId). The device id is already per-browser
 * (`getOrCreateClientDeviceId`), so a vault imported into a second browser was
 * always a distinct device with its own prekey space — nothing is lost by making
 * these unre-derivable across machines.
 *
 * Losing this store (clearing site data) means inbound handshakes that reference
 * an old prekey can no longer be accepted. That is the correct, Signal-standard
 * trade: the peer simply fetches a fresh bundle and re-handshakes. It is also
 * precisely the property that makes the old scheme's convenience a bug.
 */

const DB_NAME = 'forest-prekeys'
const DB_VERSION = 1
const STORE = 'prekeys'

type PrekeyKind = 'otp' | 'spk'

function recordKey(userId: string, deviceId: string, kind: PrekeyKind, id: number): string {
  return `${userId}:${deviceId}:${kind}:${id}`
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('PREKEY_STORE_UNAVAILABLE'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('PREKEY_STORE_OPEN_FAILED'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('PREKEY_STORE_TX_FAILED'))
    })
  } finally {
    db.close()
  }
}

/** Persist one prekey private key. Stored as raw bytes, never as a JWK. */
export async function putPrekeyPrivate(
  userId: string,
  deviceId: string,
  kind: PrekeyKind,
  id: number,
  privateKey: Uint8Array
): Promise<void> {
  // Copy into a plain ArrayBuffer — a view over a larger buffer would persist
  // whatever else shares it.
  const bytes = new Uint8Array(privateKey.length)
  bytes.set(privateKey)
  await withStore('readwrite', (s) => s.put(bytes, recordKey(userId, deviceId, kind, id)))
}

/** Fetch one prekey private key, or null when it is unknown/lost. */
export async function getPrekeyPrivate(
  userId: string,
  deviceId: string,
  kind: PrekeyKind,
  id: number
): Promise<Uint8Array | null> {
  try {
    const raw = await withStore<unknown>('readonly', (s) =>
      s.get(recordKey(userId, deviceId, kind, id)) as IDBRequest<unknown>
    )
    if (raw instanceof Uint8Array) return raw
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
    return null
  } catch {
    return null
  }
}

/**
 * Drop a consumed one-time prekey.
 *
 * One-time means one time: keeping the private key after the handshake has been
 * accepted would leave material on disk that can only ever be used to re-derive
 * a secret we already hold, and the pool would grow without bound. The replay
 * ledger (`otp-ledger.ts`) still remembers the id, so a reused id is rejected
 * even though the key is gone.
 */
export async function deletePrekeyPrivate(
  userId: string,
  deviceId: string,
  kind: PrekeyKind,
  id: number
): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(recordKey(userId, deviceId, kind, id)))
  } catch {
    /* best-effort */
  }
}

/** Wipe every prekey for this account (logout / account wipe). */
export async function clearPrekeysForUser(userId: string): Promise<void> {
  try {
    const keys = await withStore<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
    const mine = keys.filter((k) => typeof k === 'string' && k.startsWith(`${userId}:`))
    if (!mine.length) return
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        for (const k of mine) store.delete(k)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('PREKEY_STORE_CLEAR_FAILED'))
      })
    } finally {
      db.close()
    }
  } catch {
    /* best-effort */
  }
}
