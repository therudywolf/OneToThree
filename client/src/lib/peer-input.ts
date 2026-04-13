'use client'

import { canonicalUserId } from '@/lib/user-id'

/**
 * PROJECT 13 :: IDENTITY_SIGNAL_EXTRACTOR
 * Level: Core Layer (Input Normalization)
 * Vibe: Clinical Pure / Terminal Noir
 */

const SIGNATURE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** * [ID_SYNC] :: Приведение UUID к каноничному виду. 
 */
export function syncUuid(id: string): string {
  return canonicalUserId(id)
}

/** * [IDENT_PROBE] :: Извлечение идентификатора пира или поискового запроса.
 * Обрабатывает: сырые UUID, никнеймы, ссылки-приглашения.
 */
export function scanPeerIdentity(raw: string): string {
  const signal = raw.trim()
  if (!signal) return ''

  // [1] DIRECT_MATCH :: Если это прямой UUID
  if (SIGNATURE_UUID_RE.test(signal)) {
    return syncUuid(signal)
  }

  // [2] URL_INTERCEPT :: Поиск инвайт-токена в ссылке
  try {
    // Проверяем, есть ли в строке признаки линка или query-параметра
    if (signal.includes('invite=') || /^https?:\/\//i.test(signal)) {
      const urlTarget = signal.startsWith('http') ? signal : `https://p13.io/?${signal.replace(/^\?/, '')}`
      const probe = new URL(urlTarget)
      const token = probe.searchParams.get('invite')?.trim()

      if (token && SIGNATURE_UUID_RE.test(token)) {
        return syncUuid(token)
      }
    }
  } catch {
    // Сигнал искажен, продолжаем как с обычным текстом
  }

  // [3] RAW_FALLBACK :: Если это никнейм или неопознанный сигнал
  return signal
}

/** [CHECK_SIGNATURE] :: Проверка, является ли строка UUID */
// --- CONSUMER_ALIASES ---
export const normalizePeerInput = scanPeerIdentity
export const isUuid = isNodeSignature

export function isNodeSignature(value: string): boolean {
  return SIGNATURE_UUID_RE.test(value)
}