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

const MAX_RETRIES = 10
const MAX_BACKOFF_MS = 60_000
/** In-memory retry state; resets on page reload (Background Sync handles persistence). */
const retryState = new Map<string, { retries: number; nextRetry: number }>()

function emitOutboxTelemetry(payload: { attempted: number; sent: number; failed: number }) {
  if (typeof window === 'undefined') return
  const failRatio = payload.attempted > 0 ? payload.failed / payload.attempted : 0
  try {
    localStorage.setItem(
      'p13:outbox-telemetry',
      JSON.stringify({
        ...payload,
        failRatio,
        ts: new Date().toISOString(),
      })
    )
  } catch {
    /* ignore storage failures */
  }
  window.dispatchEvent(
    new CustomEvent('p13_outbox_telemetry', {
      detail: { ...payload, failRatio },
    })
  )
}

function getBackoffMs(retries: number): number {
  return Math.min(1000 * 2 ** retries, MAX_BACKOFF_MS)
}

/**
 * Retry pending outbox sends after transport comes back (WebSocket `open`,
 * `window` `online`). Processes each entry independently with exponential
 * backoff; one failing entry does not block the rest.
 */
export async function flushOutboxPending(): Promise<void> {
  if (flushingOutbox || typeof indexedDB === 'undefined') return
  flushingOutbox = true
  try {
    const entries = await readOutbox()
    let attempted = 0
    let sent = 0
    let failed = 0
    const now = Date.now()
    for (const entry of entries) {
      const state = retryState.get(entry.id) ?? { retries: 0, nextRetry: 0 }
      if (state.retries >= MAX_RETRIES) {
        await removeOutboxEntry(entry.id)
        retryState.delete(entry.id)
        continue
      }
      if (state.nextRetry > now) continue
      attempted++
      try {
        const res = await fetch(`${API_URL}/messages/send`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry.body),
        })
        if (res.ok) {
          await removeOutboxEntry(entry.id)
          retryState.delete(entry.id)
          sent++
        } else {
          state.retries++
          state.nextRetry = Date.now() + getBackoffMs(state.retries)
          retryState.set(entry.id, state)
          failed++
        }
      } catch {
        state.retries++
        state.nextRetry = Date.now() + getBackoffMs(state.retries)
        retryState.set(entry.id, state)
        failed++
      }
    }
    emitOutboxTelemetry({ attempted, sent, failed })
  } finally {
    flushingOutbox = false
  }
}
