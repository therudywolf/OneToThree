'use client'

import { openDB } from 'idb'
import type { DBSchema } from 'idb'
import type { DecryptedMessage } from '@/types/chat'

const DB_NAME = 'project13-messages'
const DB_VERSION = 1

type CachedMessage = DecryptedMessage

interface MessageCacheDb extends DBSchema {
  messages: {
    key: string
    value: CachedMessage
    indexes: {
      byChatCreated: [string, string, string]
    }
  }
}

const dbPromise = openDB<MessageCacheDb>(DB_NAME, DB_VERSION, {
  upgrade(db) {
    const store = db.createObjectStore('messages', { keyPath: 'id' })
    store.createIndex('byChatCreated', ['chat_id', 'created_at', 'id'])
  },
})

async function db() {
  return dbPromise
}

function chatRange(chatId: string): IDBKeyRange {
  return IDBKeyRange.bound([chatId, '', ''], [chatId, '\uffff', '\uffff'])
}

export async function cacheMessages(messages: DecryptedMessage[]): Promise<void> {
  if (messages.length === 0) return
  const conn = await db()
  const tx = conn.transaction('messages', 'readwrite')
  for (const message of messages) {
    await tx.store.put(message)
  }
  await tx.done
}

export async function cacheMessage(message: DecryptedMessage): Promise<void> {
  const conn = await db()
  await conn.put('messages', message)
}

export async function deleteCachedMessage(messageId: string): Promise<void> {
  const conn = await db()
  await conn.delete('messages', messageId)
}

export async function getRecentCachedMessages(
  chatId: string,
  limit = 50
): Promise<DecryptedMessage[]> {
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

