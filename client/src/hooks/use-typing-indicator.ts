'use client'

import { useCallback, useEffect, useRef } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { useChatStore } from '@/store/chatStore'

const START_THROTTLE_MS = 1000
const STOP_DEBOUNCE_MS = 3000

/**
 * Outbound typing presence engine.
 * - `typing_start` throttled to at most once/second
 * - `typing_stop` debounced to 3s inactivity
 */
export function useTypingIndicator() {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const userId = useChatStore((s) => s.userId)
  const startedRef = useRef(false)
  const lastStartRef = useRef(0)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const emitStop = useCallback(() => {
    if (!activeChatId || !userId || !startedRef.current) return
    getFmSocket().send({
      type: 'typing_stop',
      chat_id: activeChatId,
      user_id: userId,
    })
    startedRef.current = false
  }, [activeChatId, userId])

  const scheduleStop = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    stopTimerRef.current = setTimeout(() => emitStop(), STOP_DEBOUNCE_MS)
  }, [emitStop])

  const onDraftChanged = useCallback(
    (nextValue: string) => {
      if (!activeChatId || !userId) return
      const hasText = nextValue.trim().length > 0
      if (!hasText) {
        if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
        emitStop()
        return
      }
      const now = Date.now()
      if (!startedRef.current || now - lastStartRef.current >= START_THROTTLE_MS) {
        getFmSocket().send({
          type: 'typing_start',
          chat_id: activeChatId,
          user_id: userId,
        })
        startedRef.current = true
        lastStartRef.current = now
      }
      scheduleStop()
    },
    [activeChatId, emitStop, scheduleStop, userId]
  )

  const onSubmitOrClear = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    emitStop()
  }, [emitStop])

  useEffect(() => {
    return () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
      emitStop()
    }
  }, [emitStop])

  useEffect(() => {
    // Chat switch should terminate typing state in the previous chat.
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    startedRef.current = false
  }, [activeChatId])

  return { onDraftChanged, onSubmitOrClear }
}

