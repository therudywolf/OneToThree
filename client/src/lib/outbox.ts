'use client'

/**
 * PROJECT 13 :: OUTBOX_QUEUE
 * Level: Persistence Layer (Offline Message Queue)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 *
 * Stores failed message sends in IndexedDB so the service worker
 * can retry them via Background Sync API when connectivity returns.
 */

import { openDB, deleteDB } from 'idb'
import type { IDBPDatabase, DBSchema } from 'idb'
import { API_URL } from '@/lib/api/auth'
import type { SendChatMessageBody } from '@/lib/api/messages'

const DB_NAME = 'p13-outbox'
const DB_VERSION = 1
const STORE_NAME = 'pending'

export type OutboxEntry = {
  id: string
  body: SendChatMessageBody
  created_at: string
}

interface OutboxDb extends DBSchema {
  pending: {
    key: string
    value: OutboxEntry
  }
}

let conn: Promise<IDBPDatabase<OutboxDb>> | null = null

function getDb(): Promise<IDBPDatabase<OutboxDb>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'))
  }
  if (!conn) {
    conn = openDB<OutboxDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        }
      },
    })
  }
  return conn
}

/** Enqueue a message that failed to send. */
export async function enqueueOutbox(body: SendChatMessageBody): Promise<string> {
  const db = await getDb()
  const id = crypto.randomUUID()
  await db.put(STORE_NAME, {
    id,
    body,
    created_at: new Date().toISOString(),
  })
  return id
}

/** Read all pending outbox entries. */
export async function readOutbox(): Promise<OutboxEntry[]> {
  const db = await getDb()
  return db.getAll(STORE_NAME)
}

/** Remove a successfully sent entry. */
export async function removeOutboxEntry(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE_NAME, id)
}

/** Count pending entries. */
export async function outboxCount(): Promise<number> {
  const db = await getDb()
  return db.count(STORE_NAME)
}

/** Wipe the entire outbox. */
export async function purgeOutbox(): Promise<void> {
  conn = null
  if (typeof indexedDB === 'undefined') return
  await deleteDB(DB_NAME)
}

/**
 * Register a Background Sync tag with the service worker.
 * Falls back silently if Background Sync is unsupported.
 */
export async function registerOutboxSync(): Promise<void> {
  if (typeof navigator === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.ready
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ('sync' in reg && typeof (reg as any).sync?.register === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (reg as any).sync.register('outbox')
    }
  } catch {
    // Background Sync not supported or permission denied — silent
  }
}

let flushingOutbox = false

/**
 * Retry pending outbox sends after transport comes back (WebSocket `open`,
 * `window` `online`). Stops at the first failing send.
 */
export async function flushOutboxPending(): Promise<void> {
  if (flushingOutbox || typeof indexedDB === 'undefined') return
  flushingOutbox = true
  try {
    const entries = await readOutbox()
    for (const entry of entries) {
      try {
        const res = await fetch(`${API_URL}/messages/send`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry.body),
        })
        if (res.ok) {
          await removeOutboxEntry(entry.id)
        } else {
          break
        }
      } catch {
        break
      }
    }
  } finally {
    flushingOutbox = false
  }
}
