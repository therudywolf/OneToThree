'use client'

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

/**
 * ECDH key history — append-only log of public ECDH JWKs this client has
 * used at vault-unlock time. Used by the decrypt fallback path to recover
 * messages encrypted before a key rotation (e.g. after a vault re-import on
 * the same device, where messages exist in the database that were encrypted
 * to the previous public key).
 *
 * SECURITY: only public keys are stored. Private keys remain inside the
 * vault blob and never touch this store.
 */

const DB_NAME = 'p13-ecdh-history'
const DB_VERSION = 1
const STORE = 'pub_keys'
const MAX_ENTRIES_PER_USER = 16

type Entry = {
  /** Composite primary key: `${userId}::${jwk}` so duplicates collapse. */
  id: string
  userId: string
  publicJwk: string
  addedAt: number
}

interface EcdhHistoryDb extends DBSchema {
  pub_keys: {
    key: string
    value: Entry
    indexes: { byUser: string; byUserAddedAt: [string, number] }
  }
}

let conn: Promise<IDBPDatabase<EcdhHistoryDb>> | null = null

function getDb(): Promise<IDBPDatabase<EcdhHistoryDb>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IDB_UNAVAILABLE'))
  }
  if (!conn) {
    conn = openDB<EcdhHistoryDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('byUser', 'userId')
        store.createIndex('byUserAddedAt', ['userId', 'addedAt'])
      },
    })
  }
  return conn
}

/**
 * Record `publicJwk` as a key this user has unlocked. Duplicates are merged
 * (the existing entry is left intact, no timestamp churn). Trims to the
 * latest MAX_ENTRIES_PER_USER for this user.
 */
export async function recordEcdhPublicKey(
  userId: string,
  publicJwk: string
): Promise<void> {
  if (!userId || !publicJwk) return
  let db: IDBPDatabase<EcdhHistoryDb>
  try {
    db = await getDb()
  } catch {
    return
  }
  const id = `${userId}::${publicJwk}`
  const existing = await db.get(STORE, id)
  if (existing) return

  const tx = db.transaction(STORE, 'readwrite')
  await tx.store.put({ id, userId, publicJwk, addedAt: Date.now() })

  const all = await tx.store.index('byUser').getAll(userId)
  if (all.length > MAX_ENTRIES_PER_USER) {
    all.sort((a, b) => a.addedAt - b.addedAt)
    const dropCount = all.length - MAX_ENTRIES_PER_USER
    for (let i = 0; i < dropCount; i++) {
      await tx.store.delete(all[i]!.id)
    }
  }
  await tx.done
}

/**
 * Return all known public ECDH JWKs for `userId`, newest first. Includes the
 * most recently recorded key so callers can use this as the canonical
 * candidate list without separately tracking "current" vs "previous".
 */
export async function listEcdhPublicKeys(userId: string): Promise<string[]> {
  if (!userId) return []
  let db: IDBPDatabase<EcdhHistoryDb>
  try {
    db = await getDb()
  } catch {
    return []
  }
  const rows = await db.getAllFromIndex(STORE, 'byUser', userId)
  rows.sort((a, b) => b.addedAt - a.addedAt)
  return rows.map((r) => r.publicJwk)
}

/** Test-only utility — wipes the entire history store. */
export async function _clearEcdhHistoryForTests(): Promise<void> {
  conn = null
  if (typeof indexedDB === 'undefined') return
  const db = await openDB(DB_NAME, DB_VERSION)
  await db.clear(STORE)
  db.close()
}
