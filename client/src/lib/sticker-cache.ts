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

async function purgeStickerCache(): Promise<void> {
  if (!canUseIndexedDb()) return

  let rows = await stickerCacheDb.items.orderBy('timestamp').toArray()

  const expired = rows
    .filter((row) => Date.now() - row.timestamp > STICKER_CACHE_TTL_MS)
    .map((row) => row.mediaKey)

  if (expired.length > 0) {
    await stickerCacheDb.items.bulkDelete(expired)
    rows = await stickerCacheDb.items.orderBy('timestamp').toArray()
  }

  if (rows.length > STICKER_CACHE_MAX_ENTRIES) {
    const toDelete = rows
      .slice(0, rows.length - STICKER_CACHE_MAX_ENTRIES)
      .map((row) => row.mediaKey)
    await stickerCacheDb.items.bulkDelete(toDelete)
    rows = await stickerCacheDb.items.orderBy('timestamp').toArray()
  }

  let currentBytes = rows.reduce((sum, row) => sum + row.blob.size, 0)
  if (currentBytes <= STICKER_CACHE_MAX_BYTES) return

  const overflowKeys: string[] = []
  for (const row of rows) {
    if (currentBytes <= STICKER_CACHE_MAX_BYTES) break
    overflowKeys.push(row.mediaKey)
    currentBytes -= row.blob.size
  }

  if (overflowKeys.length > 0) {
    await stickerCacheDb.items.bulkDelete(overflowKeys)
  }
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
  await purgeStickerCache()
}

export async function invalidateCachedStickerBlob(mediaKey: string): Promise<void> {
  if (!canUseIndexedDb()) return
  await stickerCacheDb.items.delete(mediaKey)
}
