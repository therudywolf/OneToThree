'use client'

import { deleteDB, openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { DecryptedMessage } from '@/types/chat'

const DB_NAME = 'project13-messages'
const DB_VERSION = 2

const MAX_TOKENS_PER_MESSAGE = 80

type CachedMessage = DecryptedMessage

type SearchIndexRow = {
  token: string
  message_id: string
  chat_id: string
  created_at: string
}

interface MessageCacheDb extends DBSchema {
  messages: {
    key: string
    value: CachedMessage
    indexes: {
      byChatCreated: [string, string, string]
    }
  }
  search_index: {
    key: [string, string]
    value: SearchIndexRow
    indexes: {
      byToken: string
      byMessageId: string
    }
  }
}

let dbPromise: Promise<IDBPDatabase<MessageCacheDb>> | null = null

/** Dev/debug: drop the message cache DB so the next openDB() recreates a clean store. */
export async function purgeLocalMessageCache(): Promise<void> {
  dbPromise = null
  if (typeof indexedDB === 'undefined') return
  await deleteDB(DB_NAME)
}

function getDbPromise(): Promise<IDBPDatabase<MessageCacheDb>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('indexedDB is only available in the browser'))
  }
  if (!dbPromise) {
    dbPromise = openDB<MessageCacheDb>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('messages', { keyPath: 'id' })
          store.createIndex('byChatCreated', ['chat_id', 'created_at', 'id'])
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('search_index')) {
            const si = db.createObjectStore('search_index', {
              keyPath: ['token', 'message_id'],
            })
            si.createIndex('byToken', 'token')
            si.createIndex('byMessageId', 'message_id')
          }
        }
      },
    })
  }
  return dbPromise
}

async function db(): Promise<IDBPDatabase<MessageCacheDb>> {
  return getDbPromise()
}

function chatRange(chatId: string): IDBKeyRange {
  return IDBKeyRange.bound([chatId, '', ''], [chatId, '\uffff', '\uffff'])
}

export function tokenizeForSearch(text: string): string[] {
  const lower = text.toLowerCase()
  const parts = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 2)
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of parts) {
    if (out.length >= MAX_TOKENS_PER_MESSAGE) break
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function scheduleIdle(fn: () => void | Promise<void>): void {
  const run = () => void Promise.resolve(fn()).catch(() => {})
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => run(), { timeout: 2000 })
  } else {
    setTimeout(run, 0)
  }
}

async function removeSearchRowsForMessage(
  conn: IDBPDatabase<MessageCacheDb>,
  messageId: string
): Promise<void> {
  const tx = conn.transaction('search_index', 'readwrite')
  const idx = tx.store.index('byMessageId')
  let cursor = await idx.openCursor(IDBKeyRange.only(messageId))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

async function indexMessageContent(message: DecryptedMessage): Promise<void> {
  const conn = await db()
  await removeSearchRowsForMessage(conn, message.id)
  const tokens = tokenizeForSearch(message.plaintext ?? '')
  if (tokens.length === 0) return
  const tx = conn.transaction('search_index', 'readwrite')
  const store = tx.objectStore('search_index')
  for (const token of tokens) {
    await store.put({
      token,
      message_id: message.id,
      chat_id: message.chat_id,
      created_at: message.created_at,
    })
  }
  await tx.done
}

export async function cacheMessages(messages: DecryptedMessage[]): Promise<void> {
  if (typeof indexedDB === 'undefined' || messages.length === 0) return
  const conn = await db()
  const tx = conn.transaction('messages', 'readwrite')
  for (const message of messages) {
    await tx.store.put(message)
  }
  await tx.done
  for (const m of messages) {
    scheduleIdle(() => indexMessageContent(m))
  }
}

export async function cacheMessage(message: DecryptedMessage): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const conn = await db()
  await conn.put('messages', message)
  scheduleIdle(() => indexMessageContent(message))
}

export async function deleteCachedMessage(messageId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const conn = await db()
  await conn.delete('messages', messageId)
  await removeSearchRowsForMessage(conn, messageId)
}

export async function getRecentCachedMessages(
  chatId: string,
  limit = 50
): Promise<DecryptedMessage[]> {
  if (typeof indexedDB === 'undefined') return []
  const conn = await db()
  const tx = conn.transaction('messages', 'readonly')
  const index = tx.store.index('byChatCreated')
  const out: DecryptedMessage[] = []
  let cursor = await index.openCursor(chatRange(chatId), 'prev')
  while (cursor && out.length < limit) {
    out.push(cursor.value)
    cursor = await cursor.continue()
  }
  await tx.done
  out.reverse()
  return out
}

export async function getOlderCachedMessages(params: {
  chatId: string
  beforeCreatedAt: string
  beforeId: string
  limit?: number
}): Promise<DecryptedMessage[]> {
  if (typeof indexedDB === 'undefined') return []
  const conn = await db()
  const tx = conn.transaction('messages', 'readonly')
  const index = tx.store.index('byChatCreated')
  const out: DecryptedMessage[] = []
  const max = params.limit ?? 25
  const range = IDBKeyRange.bound(
    [params.chatId, '', ''],
    [params.chatId, params.beforeCreatedAt, params.beforeId],
    false,
    true
  )
  let cursor = await index.openCursor(range, 'prev')
  while (cursor && out.length < max) {
    out.push(cursor.value)
    cursor = await cursor.continue()
  }
  await tx.done
  out.reverse()
  return out
}

/** Local full-text–style search over cached decrypted plaintext (IndexedDB only). */
export async function searchLocalMessages(
  query: string
): Promise<Array<{ messageId: string; chatId: string }>> {
  if (typeof indexedDB === 'undefined') return []
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []

  const queryTokens = tokenizeForSearch(q)
  const searchKeys =
    queryTokens.length > 0
      ? queryTokens
      : q.length >= 2
        ? [q]
        : []

  if (searchKeys.length === 0) return []

  const conn = await db()
  const tx = conn.transaction('search_index', 'readonly')
  const idx = tx.store.index('byToken')

  async function matchesForKey(key: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const range = IDBKeyRange.bound(key, `${key}\uffff`, false, true)
    let cursor = await idx.openCursor(range)
    while (cursor) {
      const row = cursor.value as SearchIndexRow
      out.set(row.message_id, row.chat_id)
      cursor = await cursor.continue()
    }
    return out
  }

  let combined: Map<string, string> | null = null
  for (const kt of searchKeys) {
    const m = await matchesForKey(kt)
    if (m.size === 0) {
      await tx.done
      return []
    }
    if (combined === null) {
      combined = m
    } else {
      for (const id of [...combined.keys()]) {
        if (!m.has(id)) combined.delete(id)
      }
    }
  }
  await tx.done

  if (!combined || combined.size === 0) return []

  return [...combined.entries()].map(([messageId, chatId]) => ({
    messageId,
    chatId,
  }))
}
