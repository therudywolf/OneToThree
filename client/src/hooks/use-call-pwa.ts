'use client'

import { useEffect, useRef } from 'react'
import { useCallStore } from '@/store/callStore'

/**
 * PROJECT 13 :: CALL_PWA_ENHANCEMENTS
 * Level: OS Integration Layer (MediaSession, Wake Lock, Orientation)
 *
 * Provides three PWA features that activate during calls:
 * 1. MediaSession API — lock screen / notification tray call controls
 * 2. Wake Lock API — keeps screen on during calls
 * 3. Screen Orientation Lock — landscape for video calls
 */

type CallPwaOptions = {
  peerUsername: string | null
  onEndCall: () => void
  onToggleMute: () => void
  isVideo: boolean
}

export function useCallPwa({ peerUsername, onEndCall, onToggleMute, isVideo }: CallPwaOptions) {
  const isCalling = useCallStore((s) => s.isCalling)
  const localStream = useCallStore((s) => s.localStream)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)

  // --- MediaSession API ---
  useEffect(() => {
    if (!isCalling || !localStream) {
      // Clear MediaSession when call ends
      if ('mediaSession' in navigator) {
        try {
          const ms = navigator.mediaSession as MediaSession
          ms.metadata = null
          ms.setActionHandler('hangup' as MediaSessionAction, null)
          ms.setActionHandler('togglemicrophone' as MediaSessionAction, null)
        } catch { /* not supported */ }
      }
      return
    }

    if (!('mediaSession' in navigator)) return

    try {
      const displayName = peerUsername || 'Peer'
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `OneToThree — Call with ${displayName}`,
        artist: 'Encrypted call',
      })

      // 'hangup' and 'togglemicrophone' are valid MediaSession actions
      // but may not be in all TS type defs yet
      const ms = navigator.mediaSession as MediaSession
      ms.setActionHandler('hangup' as MediaSessionAction, () => onEndCall())
      ms.setActionHandler('togglemicrophone' as MediaSessionAction, () => onToggleMute())
    } catch {
      // MediaSession not fully supported — degrade gracefully
    }

    return () => {
      if ('mediaSession' in navigator) {
        try {
          const ms = navigator.mediaSession as MediaSession
          ms.metadata = null
          ms.setActionHandler('hangup' as MediaSessionAction, null)
          ms.setActionHandler('togglemicrophone' as MediaSessionAction, null)
        } catch { /* ignore */ }
      }
    }
  }, [isCalling, localStream, peerUsername, onEndCall, onToggleMute])

  // --- Wake Lock API ---
  useEffect(() => {
    if (!isCalling || !localStream) {
      // Release wake lock when call ends
      wakeLockRef.current?.release().catch(() => {})
      wakeLockRef.current = null
      return
    }

    async function acquireWakeLock() {
      if (!('wakeLock' in navigator)) return
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
      } catch {
        // Wake Lock not available or user denied
      }
    }

    void acquireWakeLock()

    // Re-acquire on visibility change (after tab switch / screen off then back)
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        isCalling &&
        !wakeLockRef.current
      ) {
        void acquireWakeLock()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      wakeLockRef.current?.release().catch(() => {})
      wakeLockRef.current = null
    }
  }, [isCalling, localStream])

  // --- Screen Orientation Lock (video calls) ---
  useEffect(() => {
    if (!isCalling || !localStream || !isVideo) return

    const hasVideoTrack = localStream.getVideoTracks().length > 0
    if (!hasVideoTrack) return

    // Lock to landscape for video calls
    // screen.orientation.lock() may not be in all TS type defs
    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (orientation: string) => Promise<void>
        unlock?: () => void
      }
      orientation.lock?.('landscape').catch(() => {
        // Not supported or not in fullscreen — ignore silently
      })
    } catch {
      // API not available
    }

    return () => {
      try {
        const orientation = screen.orientation as ScreenOrientation & {
          unlock?: () => void
        }
        orientation.unlock?.()
      } catch {
        // ignore
      }
    }
  }, [isCalling, localStream, isVideo])
}
