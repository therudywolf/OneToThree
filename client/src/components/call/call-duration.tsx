'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * PROJECT 13 :: CALL_DURATION
 *
 * The mm:ss clock in a call header, as a LEAF.
 *
 * It used to be `useState` inside the call screens themselves, ticking every
 * 500ms. Those screens are the two largest components the app ever mounts
 * (the 1:1 overlay is ~1200 lines, the group screen ~700), and each tick
 * re-rendered all of it: every tile's props rebuilt, every participant row
 * remapped, every menu reconciled — twice a second, for the whole length of
 * the call, on the one screen that is already competing with encode, decode
 * and a segmentation model for the main thread.
 *
 * Twice a second for a value that changes once a second, at that.
 *
 * Here the state is the only thing under the timer, so a tick repaints one
 * text node. The interval is also aligned to the next whole second rather than
 * free-running, so the displayed value changes when the clock says it should
 * instead of up to a second late.
 */

import { useEffect, useRef, useState } from 'react'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  // Past an hour, mm:ss alone is a lie about how long you have been on this
  // call. Below it, the hour segment is noise.
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * @param startedAt epoch ms the call began, or null while it has not.
 */
export function CallDuration({ startedAt }: { startedAt: number | null }) {
  const [text, setText] = useState(() =>
    formatDuration(startedAt ? Date.now() - startedAt : 0)
  )
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!startedAt) {
      setText(formatDuration(0))
      return
    }
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      const elapsed = Date.now() - startedAt
      setText(formatDuration(elapsed))
      // Re-arm on the NEXT second boundary rather than a fixed period: a
      // free-running 1s interval drifts, and a tab that was throttled in the
      // background comes back showing a time that is merely close.
      const delay = 1000 - ((elapsed % 1000) + 1000) % 1000
      timerRef.current = setTimeout(tick, delay || 1000)
    }
    tick()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [startedAt])

  return <>{text}</>
}
