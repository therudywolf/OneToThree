'use client'

import Dexie, { type Table } from 'dexie'
import { isAppleNode } from '@/lib/ios'

/**
 * PROJECT 13 :: DIGITAL_DEN_STORAGE
 * Level: Interface Layer (Local Cache)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/**
 * Resolve the media cache byte limit at module initialisation time.
 * iOS / iPadOS Safari imposes a much tighter Storage quota than desktop
 * browsers, so we cap the den at 40 MiB there to avoid silent eviction.
 * All other platforms get 512 MiB (previously 1 GiB — reduced to stay
 * comfortably below typical browser quota limits on low-memory desktops).
 */
function resolveMediaCacheLimit(): number {
  if (typeof navigator === 'undefined') return 512 * 1024 * 1024
  return isAppleNode() ? 40 * 1024 * 1024 : 512 * 1024 * 1024
}

/** Лимит «Норы»: платформозависимый лимит для дешифрованных бинарных сегментов. */
export const DEN_CAPACITY_LIMIT = resolveMediaCacheLimit()
/** Максимальное количество записей, чтобы IndexedDB не захлебнулась. */
export const DEN_ENTRY_LIMIT = 200

export type BinarySegmentRow = {
  /** Связь с ID сообщения. */
  id: string
  /** Отпечаток (SHA-256) для верификации целостности. */
  fileHash: string
  blob: Blob
  mimeType: string
  timestamp: number
}

class DigitalDenDexie extends Dexie {
  segments!: Table<BinarySegmentRow, string>

  constructor() {
    super('p13-digital-den')
    this.version(1).stores({
      segments: 'id, timestamp, fileHash',
    })
  }
}

const den = new DigitalDenDexie()

/** [DIGITAL_FINGERPRINT] :: Генерация SHA-256 хэша для проверки данных */
async function getFingerprint(buf: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** [EXTRACT] :: Извлечение сегмента из локальной памяти */
export async function getCachedMedia(
  messageId: string
): Promise<{ blob: Blob; mimeType: string } | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  
  const row = await den.segments.get(messageId)
  if (!row?.blob) return undefined
  
  return { blob: row.blob, mimeType: row.mimeType }
}

/** [INJECT] :: Сохранение дешифрованного сегмента с проверкой лимитов */
export async function setCachedMedia(
  messageId: string,
  blob: Blob,
  mimeType: string
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  
  const buffer = await blob.arrayBuffer()
  const fileHash = await getFingerprint(buffer)
  
  await den.segments.put({
    id: messageId,
    fileHash,
    blob,
    mimeType,
    timestamp: Date.now(),
  })
  
  await purgeOldSegments()
}

/**
 * [PURGE_PROTOCOL] :: Очистка старых данных (FIFO) при превышении квот.
 *
 * Runs on every `setCachedMedia`, so it must stay cheap: the entry cap uses a
 * key-only `count()` / `primaryKeys()` (no row deserialization), and the byte
 * cap streams a `timestamp` cursor one row at a time instead of materialising
 * the whole den into an array.
 */
export async function purgeOldSegments(
  maxSize: number = DEN_CAPACITY_LIMIT,
  maxCount: number = DEN_ENTRY_LIMIT
): Promise<void> {
  if (typeof indexedDB === 'undefined') return

  // 1. Entries cap — count and evict by key, without reading any blob row.
  const total = await den.segments.count()
  if (total > maxCount) {
    const ordered = await den.segments.orderBy('timestamp').primaryKeys()
    await den.segments.bulkDelete(ordered.slice(0, total - maxCount))
  }

  // 2. Byte cap — stream oldest-first. `Blob.size` is metadata; the bytes
  //    stay on disk (a Blob is a lazy reference), so this never holds the
  //    cache contents in memory.
  let currentSize = 0
  await den.segments.orderBy('timestamp').each((row) => {
    currentSize += row.blob?.size ?? 0
  })
  if (currentSize <= maxSize) return

  const idsToPurge: string[] = []
  let running = currentSize
  await den.segments.orderBy('timestamp').each((row) => {
    if (running <= maxSize) return
    idsToPurge.push(row.id)
    running -= row.blob?.size ?? 0
  })
  if (idsToPurge.length > 0) {
    await den.segments.bulkDelete(idsToPurge)
  }
}

/** Снятие показаний о загруженности сектора */
export async function getDigitalDenUsageBytes(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0
  const rows = await den.segments.toArray()
  return rows.reduce((acc, r) => acc + (r.blob?.size ?? 0), 0)
}

/** Полная стерилизация кэша */
export async function clearAllMediaCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await den.segments.clear()
}

