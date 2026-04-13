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
export function aggregateTransmissions(feed: DecryptedMessage[]): AggregatedNode[] {
  const result: AggregatedNode[] = []
  let buffer: DecryptedMessage[] = []
  
  const flushBuffer = () => {
    if (buffer.length === 0) return
    
    if (buffer.length === 1) {
      result.push({ type: 'UNIT', message: buffer[0] })
    } else {
      result.push({
        type: 'COLLECTION',
        messages: [...buffer],
        originId: buffer[0].sender_id,
        timestamp: new Date(buffer[0].created_at)
      })
    }
    buffer = []
  }

  for (const packet of feed) {
    const isVisual = isVisualSegment(packet)
    const packetTime = new Date(packet.created_at).getTime()
    
    // Проверка условий для вхождения в текущую коллекцию
    const canCluster = buffer.length > 0 &&
      packet.sender_id === buffer[0].sender_id &&
      isVisual &&
      (packetTime - new Date(buffer[buffer.length - 1].created_at).getTime()) <= 60000

    if (canCluster) {
      buffer.push(packet)
    } else {
      flushBuffer()
      
      if (isVisual) {
        buffer = [packet]
      } else {
        result.push({ type: 'UNIT', message: packet })
      }
    }
  }

  flushBuffer()
  return result
}