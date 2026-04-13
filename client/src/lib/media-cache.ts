'use client'

import Dexie, { type Table } from 'dexie'

/**
 * PROJECT 13 :: DIGITAL_DEN_STORAGE
 * Level: Interface Layer (Local Cache)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/** Лимит «Норы»: 1 GiB для дешифрованных бинарных сегментов. */
export const DEN_CAPACITY_LIMIT = 1024 * 1024 * 1024
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
export async function getCachedSegment(
  messageId: string
): Promise<{ blob: Blob; mimeType: string } | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  
  const row = await den.segments.get(messageId)
  if (!row?.blob) return undefined
  
  return { blob: row.blob, mimeType: row.mimeType }
}

/** [INJECT] :: Сохранение дешифрованного сегмента с проверкой лимитов */
export async function setCachedSegment(
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

/** [PURGE_PROTOCOL] :: Очистка старых данных (FIFO) при превышении квот */
export async function purgeOldSegments(
  maxSize: number = DEN_CAPACITY_LIMIT,
  maxCount: number = DEN_ENTRY_LIMIT
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  
  let rows = await den.segments.orderBy('timestamp').toArray()

  // 1. Проверка лимита по количеству (Entries Cap)
  if (rows.length > maxCount) {
    const toDelete = rows.slice(0, rows.length - maxCount).map(r => r.id)
    await den.segments.bulkDelete(toDelete)
    rows = await den.segments.orderBy('timestamp').toArray()
  }

  // 2. Проверка лимита по объему (Byte Cap)
  let currentSize = rows.reduce((acc, r) => acc + (r.blob?.size ?? 0), 0)
  if (currentSize <= maxSize) return

  const idsToPurge: string[] = []
  for (const row of rows) {
    if (currentSize <= maxSize) break
    idsToPurge.push(row.id)
    currentSize -= row.blob?.size ?? 0
  }

  if (idsToPurge.length > 0) {
    await den.segments.bulkDelete(idsToPurge)
  }
}

/** Снятие показаний о загруженности сектора */
export async function getDenUsage(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0
  const rows = await den.segments.toArray()
  return rows.reduce((acc, r) => acc + (r.blob?.size ?? 0), 0)
}

/** Полная стерилизация кэша */
export async function wipeDigitalDen(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await den.segments.clear()
}