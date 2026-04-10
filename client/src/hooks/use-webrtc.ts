'use client'

import { useCallback, useEffect, useState } from 'react'
import { useCallStore } from '@/store/callStore'

function stopStreamTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

function closeSession(c: { close: () => void } | undefined) {
  try {
    c?.close()
  } catch {
    /* ignore */
  }
}

/**
 * Native WebRTC over app WebSockets will replace this stub (Phase 2).
 */
export function useWebRTC(userId: string | null) {
  const [peerReady, setPeerReady] = useState(false)

  const setIncomingCall = useCallStore((s) => s.setIncomingCall)
  const resetCallStore = useCallStore((s) => s.reset)

  const endCall = useCallback(() => {
    const state = useCallStore.getState()
    Object.values(state.connections).forEach((c) => closeSession(c))
    stopStreamTracks(state.localStream)
    resetCallStore()
  }, [resetCallStore])

  useEffect(() => {
    if (!userId) {
      setPeerReady(false)
      return
    }
    setPeerReady(false)
    return () => {
      endCall()
    }
  }, [userId, endCall])

  const rejectIncomingCall = useCallback(() => {
    const inc = useCallStore.getState().incomingCall
    if (inc) {
      closeSession(inc.call)
      setIncomingCall(null)
    }
  }, [setIncomingCall])

  const acceptIncomingCall = useCallback(async () => {}, [])

  const initiateCall = useCallback(async (_recipientIds: string[], _isVideo: boolean) => {}, [])

  const toggleMuteMic = useCallback(() => {
    const s = useCallStore.getState().localStream
    s?.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
  }, [])

  const toggleCamera = useCallback(() => {
    const s = useCallStore.getState().localStream
    s?.getVideoTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
  }, [])

  return {
    peerReady,
    initiateCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endCall,
    toggleMuteMic,
    toggleCamera,
  }
}

export async function fetchPeerIdsForChat(
  _chatId: string,
  _myUserId: string
): Promise<string[]> {
  return []
}
