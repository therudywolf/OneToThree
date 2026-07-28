'use client'

import Dexie, { type Table } from 'dexie'

const STICKER_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14
const STICKER_CACHE_MAX_BYTES = 256 * 1024 * 1024
const STICKER_CACHE_MAX_ENTRIES = 500

type StickerCacheRow = {
  mediaKey: string
  blob: Blob
  mimeType: string
  timestamp: number
}

class StickerCacheDexie extends Dexie {
  items!: Table<StickerCacheRow, string>

  constructor() {
    super('p13-sticker-cache')
    this.version(1).stores({
      items: 'mediaKey, timestamp',
    })
  }
}

const stickerCacheDb = new StickerCacheDexie()

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

/**
 * FIFO purge under the TTL / entry / byte caps.
 *
 * This runs behind every sticker write, i.e. once per sticker while a 120-item
 * pack loads. It must therefore stay cheap. It used to `orderBy('timestamp')
 * .toArray()` the whole store — up to 500 structured-clone deserialisations —
 * and did so up to THREE times per call, so opening a picker cost tens of
 * thousands of row reads on the main thread and visibly stalled. Same treatment
 * as `purgeOldSegments` in media-cache.ts: key-only queries for the TTL and
 * entry caps, a streaming cursor for the byte cap.
 */
async function purgeStickerCache(): Promise<void> {
  if (!canUseIndexedDb()) return

  // 1. TTL — key-only range query on the `timestamp` index.
  const cutoff = Date.now() - STICKER_CACHE_TTL_MS
  const expired = await stickerCacheDb.items.where('timestamp').below(cutoff).primaryKeys()
  if (expired.length > 0) {
    await stickerCacheDb.items.bulkDelete(expired)
  }

  // 2. Entry cap — count and evict by key, without reading any blob row.
  const total = await stickerCacheDb.items.count()
  if (total > STICKER_CACHE_MAX_ENTRIES) {
    const ordered = await stickerCacheDb.items.orderBy('timestamp').primaryKeys()
    await stickerCacheDb.items.bulkDelete(ordered.slice(0, total - STICKER_CACHE_MAX_ENTRIES))
  }

  // 3. Byte cap — stream oldest-first. `Blob.size` is metadata; the bytes stay
  //    on disk (a Blob is a lazy reference), so this never materialises the
  //    cache contents in memory.
  let currentBytes = 0
  await stickerCacheDb.items.orderBy('timestamp').each((row) => {
    currentBytes += row.blob?.size ?? 0
  })
  if (currentBytes <= STICKER_CACHE_MAX_BYTES) return

  const overflowKeys: string[] = []
  let running = currentBytes
  await stickerCacheDb.items.orderBy('timestamp').each((row) => {
    if (running <= STICKER_CACHE_MAX_BYTES) return
    overflowKeys.push(row.mediaKey)
    running -= row.blob?.size ?? 0
  })

  if (overflowKeys.length > 0) {
    await stickerCacheDb.items.bulkDelete(overflowKeys)
  }
}

// Coalesce bursts. A pack load fires setCachedStickerBlob ~120 times back to
// back and the caps are soft — one trailing purge per burst is enough, and it
// keeps the picker's first paint off the purge's critical path.
const PURGE_DEBOUNCE_MS = 750
let purgeTimer: ReturnType<typeof setTimeout> | null = null

function scheduleStickerCachePurge(): void {
  if (!canUseIndexedDb() || purgeTimer !== null) return
  purgeTimer = setTimeout(() => {
    purgeTimer = null
    void purgeStickerCache().catch(() => {
      /* cache hygiene is best-effort */
    })
  }, PURGE_DEBOUNCE_MS)
}

export async function getCachedStickerBlob(
  mediaKey: string
): Promise<{ blob: Blob; mimeType: string } | undefined> {
  if (!canUseIndexedDb()) return undefined
  const row = await stickerCacheDb.items.get(mediaKey)
  if (!row) return undefined
  if (Date.now() - row.timestamp > STICKER_CACHE_TTL_MS) {
    await stickerCacheDb.items.delete(mediaKey)
    return undefined
  }
  return { blob: row.blob, mimeType: row.mimeType }
}

export async function setCachedStickerBlob(
  mediaKey: string,
  blob: Blob,
  mimeType: string
): Promise<void> {
  if (!canUseIndexedDb()) return
  await stickerCacheDb.items.put({
    mediaKey,
    blob,
    mimeType,
    timestamp: Date.now(),
  })
  scheduleStickerCachePurge()
}

export async function invalidateCachedStickerBlob(mediaKey: string): Promise<void> {
  if (!canUseIndexedDb()) return
  await stickerCacheDb.items.delete(mediaKey)
}
