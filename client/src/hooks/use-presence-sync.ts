'use client'

import { useEffect, useMemo } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { fetchUserPresence } from '@/lib/api/users'
import { useChatStore } from '@/store/chatStore'
import type { ApiChatRow } from '@/lib/api/chats'

/**
 * PROJECT 13 :: PULSE_RADAR_PROTOCOL
 * Level: Connection Layer (Presence Tracking)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

const HEARTBEAT_INTERVAL_MS = 45_000

/**
 * Синхронизация статусов «В сети» через REST (Initial) и WS (Real-time).
 * Поддерживает активность узла в контуре через presence_ping.
 */
// --- CONSUMER_ALIAS ---
export const usePresenceSync = usePulseRadar

export function usePulseRadar(userId: string, sectors: ApiChatRow[]) {
  const { mergePeerPresenceBatch, setPeerPresence } = useChatStore()

  // [1] PEER_ID_EXTRACTION :: Выделяем идентификаторы пиров из активных линков
  const targetPeerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const sector of sectors) {
      if (sector.is_group) continue // Групповые секторы обрабатываются иначе
      const peer = sector.member_ids.find((id) => id !== userId)
      if (peer) ids.add(peer)
    }
    return [...ids]
  }, [sectors, userId])

  // [2] INITIAL_SCAN :: Первичный запрос состояний через REST-шлюз
  useEffect(() => {
    if (targetPeerIds.length === 0) return
    
    let isAborted = false
    
    void fetchUserPresence(targetPeerIds)
      .then((rows) => {
        if (!isAborted) mergePeerPresenceBatch(rows)
      })
      .catch(() => {
        // Сигнал потерян или шлюз закрыт — игнорируем, ждем WS
      })

    return () => {
      isAborted = true
    }
  }, [targetPeerIds, mergePeerPresenceBatch])

  // [3] SIGNAL_INTERCEPT :: Подписка на изменение пульса через WebSocket
  useEffect(() => {
    const socket = getFmSocket()
    
    /** [INTERCEPTOR] :: Фильтрация входящих пакетов статуса */
    return socket.subscribe((packet) => {
      if (packet.type !== 'online_status_change') return
      
      setPeerPresence(packet.user_id, {
        online: packet.online,
        last_seen_at: packet.last_seen_at,
      })
    })
  }, [setPeerPresence])

  // [4] KEEP_ALIVE_PULSE :: Поддержание активности узла в сети
  useEffect(() => {
    const heartbeat = window.setInterval(() => {
      const socket = getFmSocket()
      if (!socket.connected) return
      
      /** Отправляем легкий пинг для подтверждения присутствия в секторе */
      socket.send({ type: 'presence_ping' })
    }, HEARTBEAT_INTERVAL_MS)

    return () => window.clearInterval(heartbeat)
  }, [])
}