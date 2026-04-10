'use client'

import Dexie, { type Table } from 'dexie'

/** Default cap for decrypted media blobs (1 GiB). */
export const MEDIA_CACHE_MAX_BYTES = 1024 * 1024 * 1024

/** Hard cap on row count so opening huge histories does not flood IndexedDB before byte trim runs. */
export const MEDIA_CACHE_MAX_ENTRIES = 200

export type MediaCacheRow = {
  /** `messages.id` — one row per message attachment. */
  id: string
  /** SHA-256 hex of decrypted payload (integrity / dedupe metadata). */
  fileHash: string
  blob: Blob
  mimeType: string
  timestamp: number
}

class MediaCacheDexie extends Dexie {
  media_cache!: Table<MediaCacheRow, string>

  constructor() {
    super('project13-media-cache')
    this.version(1).stores({
      media_cache: 'id, timestamp, fileHash',
    })
  }
}

const db = new MediaCacheDexie()

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(h))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Returns decrypted blob + mime if present. */
export async function getCachedMedia(
  messageId: string
): Promise<{ blob: Blob; mimeType: string } | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  const row = await db.media_cache.get(messageId)
  if (!row?.blob) return undefined
  return { blob: row.blob, mimeType: row.mimeType }
}

/** Persists decrypted media; enforces size cap (drops oldest first). */
export async function setCachedMedia(
  messageId: string,
  blob: Blob,
  mimeType: string
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const ab = await blob.arrayBuffer()
  const fileHash = await sha256Hex(ab)
  await db.media_cache.put({
    id: messageId,
    fileHash,
    blob,
    mimeType,
    timestamp: Date.now(),
  })
  await clearOldCache()
}

/**
 * Removes oldest entries until total size is under {@link MEDIA_CACHE_MAX_BYTES}.
 */
export async function clearOldCache(
  maxBytes: number = MEDIA_CACHE_MAX_BYTES,
  maxEntries: number = MEDIA_CACHE_MAX_ENTRIES
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  let rows = await db.media_cache.orderBy('timestamp').toArray()

  if (rows.length > maxEntries) {
    const overflow = rows.length - maxEntries
    for (let i = 0; i < overflow; i++) {
      await db.media_cache.delete(rows[i].id)
    }
    rows = await db.media_cache.orderBy('timestamp').toArray()
  }

  let total = rows.reduce((s, r) => s + (r.blob?.size ?? 0), 0)
  if (total <= maxBytes) return
  for (const r of rows) {
    if (total <= maxBytes) break
    await db.media_cache.delete(r.id)
    total -= r.blob?.size ?? 0
  }
}

export async function getDigitalDenUsageBytes(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0
  const rows = await db.media_cache.toArray()
  return rows.reduce((s, r) => s + (r.blob?.size ?? 0), 0)
}

export async function clearAllMediaCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await db.media_cache.clear()
}
