'use client'

import { useCallback, useEffect, useRef } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { useChatStore } from '@/store/chatStore'

/**
 * PROJECT 13 :: INPUT_PRESENCE_ENGINE
 * Level: Presence Layer (Pulse Control)
 * Vibe: Clinical / Terminal Noir
 */

const THROTTLE_INTERVAL = 1500 // Интервал между сигналами старта (мс)
const TERMINATE_DEBOUNCE = 3000 // Задержка перед обрывом сигнала (мс)

export function useTypingIndicator() {
  const activeChatId = useChatStore(s => s.activeChatId)
  const userId = useChatStore(s => s.userId)
  
  const isTypingActive = useRef(false)
  const lastSignalTime = useRef(0)
  const terminateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // [SIGNAL_TERMINATE] :: Обрыв сигнала активности
  const stopPresence = useCallback(() => {
    if (!activeChatId || !userId || !isTypingActive.current) return

    getFmSocket().send({
      type: 'typing_stop',
      chat_id: activeChatId,
      user_id: userId,
    })
    
    isTypingActive.current = false
    if (terminateTimer.current) {
      clearTimeout(terminateTimer.current)
      terminateTimer.current = null
    }
  }, [activeChatId, userId])

  // [SIGNAL_PULSE] :: Планирование автоматического обрыва
  const scheduleTermination = useCallback(() => {
    if (terminateTimer.current) clearTimeout(terminateTimer.current)
    terminateTimer.current = setTimeout(stopPresence, TERMINATE_DEBOUNCE)
  }, [stopPresence])

  // [INPUT_HANDLERS] :: Обработка изменения входного потока
  const onDraftChanged = useCallback(
    (nextValue: string) => {
      if (!activeChatId || !userId) return

      const content = nextValue.trim()
      
      // Если поле пустое — немедленный обрыв сигнала
      if (content.length === 0) {
        stopPresence()
        return
      }

      const now = Date.now()
      const timeSinceLastPulse = now - lastSignalTime.current

      // Троттлинг сигнала старта: не частим, бережем канал
      if (!isTypingActive.current || timeSinceLastPulse >= THROTTLE_INTERVAL) {
        getFmSocket().send({
          type: 'typing_start',
          chat_id: activeChatId,
          user_id: userId,
        })
        isTypingActive.current = true
        lastSignalTime.current = now
      }

      scheduleTermination()
    },
    [activeChatId, userId, stopPresence, scheduleTermination]
  )

  // Сброс при отправке или ручной очистке
  const forceTerminate = useCallback(() => {
    stopPresence()
  }, [stopPresence])

  // [LIFECYCLE_CLEANUP] :: Изоляция при демонтаже или смене узла
  useEffect(() => {
    return () => stopPresence()
  }, [stopPresence])

  useEffect(() => {
    // При переключении чата старый сигнал должен быть немедленно аннулирован
    stopPresence()
    isTypingActive.current = false
  }, [activeChatId, stopPresence])

  return { 
    onDraftChanged, 
    onSubmitOrClear: forceTerminate 
  }
}