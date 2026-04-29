'use client'

/**
 * PROJECT 13 :: IDENTITY_ICON_CORTEX
 * Level: Interface Layer (Visual Assets)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * Purpose: Global in-memory registry for node icons (avatars).
 */

import { fetchAvatarDownloadUrl } from '@/lib/api/avatar'
import { fetchWithTimeout } from '@/lib/api/fetch'

/** [ICON_REGISTRY] :: Дешифрованные blob-ссылки аватаров */
const ICON_REGISTRY = new Map<string, string>()

/** [PENDING_INTERCEPT] :: Очередь активных запросов к хранилищу */
const PENDING_INTERCEPT = new Map<string, Promise<string | null>>()

/**
 * [INTERCEPT_ICON_SIGNAL]
 * Извлекает и кэширует визуальную сигнатуру узла (userId).
 * Предотвращает дублирование запросов к S3-шлюзу.
 */
export async function getCachedAvatarUrl(userId: string): Promise<string | null> {
  // 1. Проверка локального реестра
  const cached = ICON_REGISTRY.get(userId)
  if (cached) return cached

  // 2. Проверка очереди активного перехвата
  const ongoing = PENDING_INTERCEPT.get(userId)
  if (ongoing) return ongoing

  // 3. Инициализация нового цикла загрузки
  const interceptTask = downloadIconSegment(userId)
  PENDING_INTERCEPT.set(userId, interceptTask)

  try {
    const result = await interceptTask
    if (result) {
      ICON_REGISTRY.set(userId, result)
    }
    return result
  } finally {
    PENDING_INTERCEPT.delete(userId)
  }
}

/** [INTERNAL_DOWNLOAD] :: Физическое извлечение сегмента данных */
async function downloadIconSegment(userId: string): Promise<string | null> {
  try {
    // Получение временного линка от ядра
    const signedUrl = await fetchAvatarDownloadUrl(userId)
    if (!signedUrl) return null

    // Захват бинарного сегмента
    // Avatar bytes can use the SW/HTTP cache (signed URL is short-lived but
    // bytes themselves are stable for the URL's lifetime).
    const response = await fetchWithTimeout(signedUrl, { cache: 'default' })
    if (!response.ok) throw new Error(`SIGNAL_FETCH_FAULT: ${response.status}`)

    const blob = await response.blob()

    // Генерация локального Object URL
    return URL.createObjectURL(blob)
  } catch (err) {
    console.error('>> [SYS.AVATAR] INTERCEPT_FAILED:', userId, err)
    return null
  }
}

/**
 * [PURGE_ICON_TRACE]
 * Аннигиляция кэшированной иконки для конкретного узла.
 * Вызывать при получении сигнала 'user_updated' через WebSocket.
 */
export function invalidateAvatarCache(userId: string): void {
  const cachedUrl = ICON_REGISTRY.get(userId)
  if (cachedUrl) {
    URL.revokeObjectURL(cachedUrl)
    ICON_REGISTRY.delete(userId)
  }

  // Сброс зависшего обещания
  PENDING_INTERCEPT.delete(userId)
}

/** [STERILIZE_CORTEX] :: Полная очистка визуального реестра */
export function clearAllAvatarCache(): void {
  for (const url of ICON_REGISTRY.values()) {
    URL.revokeObjectURL(url)
  }

  ICON_REGISTRY.clear()
  PENDING_INTERCEPT.clear()
}