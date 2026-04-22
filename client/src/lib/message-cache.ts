'use client'

import { deleteDB, openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { DecryptedMessage } from '@/types/chat'

/**
 * PROJECT 13 :: LEXICAL_TRACE_CORE
 * Level: Core Layer (Local Persistence)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

const CORE_NAME = 'p13-ghost-logs'
const CORE_VERSION = 2
const MAX_LEXICAL_TOKENS = 80

type SearchTraceRow = {
  token: string
  message_id: string
  chat_id: string
  created_at: string
}

interface GhostLogsDb extends DBSchema {
  message_feed: {
    key: string
    value: DecryptedMessage
    indexes: { bySectorCreated: [string, string, string] }
  }
  lexical_trace: {
    key: [string, string]
    value: SearchTraceRow
    indexes: { byToken: string; byMessageId: string }
  }
}

let connection: Promise<IDBPDatabase<GhostLogsDb>> | null = null

/** [WIPE_PROTOCOL] :: Стерилизация локального кэша */
export async function purgeLocalMessageCache(): Promise<void> {
  connection = null
  if (typeof indexedDB === 'undefined') return
  await deleteDB(CORE_NAME)
}

function initConnection(): Promise<IDBPDatabase<GhostLogsDb>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('CRITICAL_FAULT :: IndexedDB offline'))
  }
  if (!connection) {
    connection = openDB<GhostLogsDb>(CORE_NAME, CORE_VERSION, {
      upgrade(db, oldVer) {
        if (oldVer < 1) {
          const feed = db.createObjectStore('message_feed', { keyPath: 'id' })
          feed.createIndex('bySectorCreated', ['chat_id', 'created_at', 'id'])
        }
        if (oldVer < 2) {
          if (!db.objectStoreNames.contains('lexical_trace')) {
            const trace = db.createObjectStore('lexical_trace', {
              keyPath: ['token', 'message_id'],
            })
            trace.createIndex('byToken', 'token')
            trace.createIndex('byMessageId', 'message_id')
          }
        }
      },
    })
  }
  return connection
}

/** [TOKENIZE] :: Разбивка текста на атомарные токены для радара */
export function tokenizeSignal(text: string): string[] {
  const parts = text.toLowerCase().split(/[^a-z0-9а-яё]+/).filter(t => t.length >= 2)
  const registry = new Set<string>()
  const output: string[] = []
  
  for (const token of parts) {
    if (output.length >= MAX_LEXICAL_TOKENS) break
    if (registry.has(token)) continue
    registry.add(token)
    output.push(token)
  }
  return output
}

/** [IDLE_DISPATCH] :: Запуск задач в фоновом шуме системы */
function scheduleTrace(fn: () => void | Promise<void>): void {
  const exec = () => void Promise.resolve(fn()).catch(() => {})
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => exec(), { timeout: 2000 })
  } else {
    setTimeout(exec, 0)
  }
}

async function purgeTraceForNode(conn: IDBPDatabase<GhostLogsDb>, msgId: string) {
  const tx = conn.transaction('lexical_trace', 'readwrite')
  const idx = tx.store.index('byMessageId')
  let cursor = await idx.openCursor(IDBKeyRange.only(msgId))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

async function indexNodeContent(msg: DecryptedMessage): Promise<void> {
  const conn = await initConnection()
  await purgeTraceForNode(conn, msg.id)
  
  const tokens = tokenizeSignal(msg.plaintext ?? '')
  if (tokens.length === 0) return

  const tx = conn.transaction('lexical_trace', 'readwrite')
  for (const token of tokens) {
    await tx.store.put({
      token,
      message_id: msg.id,
      chat_id: msg.chat_id,
      created_at: msg.created_at,
    })
  }
  await tx.done
}

// --- PUBLIC_INTERFACE ---

export async function cacheMessages(nodes: DecryptedMessage[]): Promise<void> {
  if (typeof indexedDB === 'undefined' || nodes.length === 0) return
  const conn = await initConnection()
  const tx = conn.transaction('message_feed', 'readwrite')
  for (const node of nodes) await tx.store.put(node)
  await tx.done
  for (const node of nodes) scheduleTrace(() => indexNodeContent(node))
  if (typeof window !== 'undefined') {
    const affectedChats = new Set(nodes.map((n) => n.chat_id))
    for (const chatId of affectedChats) {
      window.dispatchEvent(new CustomEvent(MESSAGE_CACHED_EVENT, { detail: { chatId } }))
    }
  }
}

export const MESSAGE_CACHED_EVENT = 'p13:message-cached'

export async function cacheMessage(node: DecryptedMessage): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const conn = await initConnection()
  await conn.put('message_feed', node)
  scheduleTrace(() => indexNodeContent(node))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(MESSAGE_CACHED_EVENT, { detail: { chatId: node.chat_id } }))
  }
}

export async function getRecentCachedMessages(chatId: string, limit = 50): Promise<DecryptedMessage[]> {
  if (typeof indexedDB === 'undefined') return []
  const conn = await initConnection()
  const range = IDBKeyRange.bound([chatId, '', ''], [chatId, '\uffff', '\uffff'])
  const tx = conn.transaction('message_feed', 'readonly')
  const idx = tx.store.index('bySectorCreated')
  
  const logs: DecryptedMessage[] = []
  let cursor = await idx.openCursor(range, 'prev')
  
  while (cursor && logs.length < limit) {
    logs.push(cursor.value)
    cursor = await cursor.continue()
  }
  return logs.reverse()
}

/**
 * Messages strictly older than `before` in this chat (by index key order).
 */
export async function getOlderCachedMessages(
  chatId: string,
  before: { created_at: string; id: string },
  limit = 50
): Promise<DecryptedMessage[]> {
  if (typeof indexedDB === 'undefined') return []
  const conn = await initConnection()
  const lower: [string, string, string] = [chatId, '', '']
  const upper: [string, string, string] = [chatId, before.created_at, before.id]
  const range = IDBKeyRange.bound(lower, upper, false, true)
  const tx = conn.transaction('message_feed', 'readonly')
  const idx = tx.store.index('bySectorCreated')

  const logs: DecryptedMessage[] = []
  let cursor = await idx.openCursor(range, 'prev')
  while (cursor && logs.length < limit) {
    logs.push(cursor.value)
    cursor = await cursor.continue()
  }
  return logs.reverse()
}

/** Get the most recent cached message for a chat (for sidebar preview). */
export async function getLastCachedMessageForChat(chatId: string): Promise<DecryptedMessage | null> {
  if (typeof indexedDB === 'undefined') return null
  const conn = await initConnection()
  const range = IDBKeyRange.bound([chatId, '', ''], [chatId, '\uffff', '\uffff'])
  const tx = conn.transaction('message_feed', 'readonly')
  const idx = tx.store.index('bySectorCreated')
  const cursor = await idx.openCursor(range, 'prev')
  return cursor?.value ?? null
}

/** Delete a single cached message by id. */
export async function deleteCachedMessage(messageId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const conn = await initConnection()
  const tx = conn.transaction('message_feed', 'readwrite')
  await tx.store.delete(messageId)
  await tx.done
}

export async function searchLocalMessages(query: string) {
  if (typeof indexedDB === 'undefined') return []
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []

  const searchTokens = tokenizeSignal(q)
  if (searchTokens.length === 0) return []

  const conn = await initConnection()
  const tx = conn.transaction('lexical_trace', 'readonly')
  const idx = tx.store.index('byToken')

  let results: Map<string, string> | null = null

  for (const token of searchTokens) {
    const currentMatches = new Map<string, string>()
    const range = IDBKeyRange.bound(token, `${token}\uffff`, false, true)
    let cursor = await idx.openCursor(range)
    
    while (cursor) {
      currentMatches.set(cursor.value.message_id, cursor.value.chat_id)
      cursor = await cursor.continue()
    }

    if (currentMatches.size === 0) return [] // Прямое пересечение (AND)
    
    if (results === null) {
      results = currentMatches
    } else {
      for (const id of results.keys()) {
        if (!currentMatches.has(id)) results.delete(id)
      }
    }
  }

  return results ? [...results.entries()].map(([messageId, chatId]) => ({ messageId, chatId })) : []
}