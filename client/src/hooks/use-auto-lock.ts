'use client'

import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import { useCallStore } from '@/store/callStore'

/**
 * PROJECT 13 :: AUTO_LOCK_PROTOCOL
 * Level: Security Layer (Inactivity Detection)
 * Auto-locks the vault after a configurable period of inactivity.
 */

const STORAGE_KEY = 'p13:auto_lock_timeout'
const USER_EVENTS: Array<keyof WindowEventMap> = [
  'mousemove',
  'keydown',
  'touchstart',
  'click',
]

export type AutoLockTimeout = 60_000 | 300_000 | 900_000 | 1_800_000 | 0

export const AUTO_LOCK_OPTIONS: Array<{ value: AutoLockTimeout; labelKey: string }> = [
  { value: 60_000, labelKey: 'settings.autoLock1min' },
  { value: 300_000, labelKey: 'settings.autoLock5min' },
  { value: 900_000, labelKey: 'settings.autoLock15min' },
  { value: 1_800_000, labelKey: 'settings.autoLock30min' },
  { value: 0, labelKey: 'settings.autoLockNever' },
]

export function loadAutoLockTimeout(): AutoLockTimeout {
  if (typeof window === 'undefined') return 300_000
  const raw = localStorage.getItem(STORAGE_KEY)
  const parsed = Number(raw)
  if (AUTO_LOCK_OPTIONS.some((o) => o.value === parsed)) return parsed as AutoLockTimeout
  return 300_000 // default: 5 minutes
}

export function saveAutoLockTimeout(value: AutoLockTimeout): void {
  localStorage.setItem(STORAGE_KEY, String(value))
}

export function useAutoLock() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setUnwrappedPrivateKey = useSessionStore((s) => s.setUnwrappedPrivateKey)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)

  useEffect(() => {
    if (!unwrappedPrivateKey) return

    // Function declarations, not consts: `lockVault` has to be able to re-arm
    // via `resetTimer`, and `resetTimer` schedules `lockVault` — hoisting is
    // what lets the two reference each other inside this closure.
    function lockVault() {
      // Don't lock during an active call — but DO re-arm. The timeout is
      // one-shot, so skipping without rescheduling meant that a call spanning
      // the first tick disarmed auto-lock for the rest of the session: this
      // effect doesn't re-run (its deps didn't change), and only a
      // mousemove/keydown/touchstart/click could ever set the timer again. A
      // video call where the user never touches the input devices, then walks
      // away, left the vault unlocked indefinitely.
      const callState = useCallStore.getState()
      if (callState.isCalling) {
        resetTimer()
        return
      }

      setUnwrappedPrivateKey(null)
    }

    function resetTimer() {
      if (timerRef.current) clearTimeout(timerRef.current)
      const timeout = loadAutoLockTimeout()
      if (timeout === 0) return // "Never" — don't set timer
      timerRef.current = setTimeout(lockVault, timeout)
    }

    resetTimer()

    const handlers = USER_EVENTS.map((event) => {
      const handler = () => resetTimer()
      window.addEventListener(event, handler, { passive: true })
      return { event, handler }
    })

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      handlers.forEach(({ event, handler }) =>
        window.removeEventListener(event, handler)
      )
    }
  }, [unwrappedPrivateKey, setUnwrappedPrivateKey])
}
