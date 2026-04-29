'use client'

import type { DecryptedMessage } from '@/types/chat'

/**
 * PROJECT 13 :: TRANSMISSION_AGGREGATOR
 * Level: Interface Layer (UI/UX Optimization)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export type AggregatedNode = {
  type: 'UNIT'
  message: DecryptedMessage
} | {
  type: 'COLLECTION'
  messages: DecryptedMessage[]
  originId: string
  timestamp: Date
}

/** [SIGNAL_PROBE] :: Проверка, является ли пакет визуальным сегментом */
function isVisualSegment(msg: DecryptedMessage): boolean {
  if (msg.media_type === 'image') return true
  
  if (msg.plaintext) {
    try {
      const envelope = JSON.parse(msg.plaintext)
      return envelope.p13 === 'attachment' && envelope.v === 1 && envelope.mimeType?.startsWith('image/')
    } catch {
      return false
    }
  }
  return false
}

/**
 * [AGGREGATE_TRANSMISSIONS] :: Группировка последовательных визуальных пакетов в коллекции.
 * Лимит разрыва между пакетами: 60 секунд.
 */
// --- CONSUMER_ALIAS ---
export const groupMessages = aggregateTransmissions

export function aggregateTransmissions(feed: DecryptedMessage[]): AggregatedNode[] {
  // Important: we no longer cluster two separate single-image sends into a
  // visual COLLECTION. Albums must be created at SEND time (the explicit
  // ALBUM envelope path produces a single message that AlbumBubble renders
  // as one card). Two consecutive solo photos stay two distinct bubbles —
  // matches Telegram behaviour where only "selected together" → one card.
  return feed.map((message) => ({ type: 'UNIT', message }))
}

// Keep `isVisualSegment` exported for any future callers; it is a no-op for
// the current renderer but the helper is used in tests.
export { isVisualSegment }