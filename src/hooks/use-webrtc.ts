'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Peer from 'peerjs'
import type { MediaConnection } from 'peerjs'
import { createClient } from '@/lib/supabase/client'
import { useCallStore } from '@/store/callStore'

const ICE: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

function stopStreamTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

function closeMediaConnection(c: MediaConnection | undefined) {
  try {
    c?.close()
  } catch {
    /* ignore */
  }
}

export function useWebRTC(userId: string | null) {
  const peerRef = useRef<Peer | null>(null)
  const [peerReady, setPeerReady] = useState(false)

  const setLocalStream = useCallStore((s) => s.setLocalStream)
  const setRemoteStream = useCallStore((s) => s.setRemoteStream)
  const removeRemoteStream = useCallStore((s) => s.removeRemoteStream)
  const setIncomingCall = useCallStore((s) => s.setIncomingCall)
  const setIsCalling = useCallStore((s) => s.setIsCalling)
  const setConnection = useCallStore((s) => s.setConnection)
  const removeConnection = useCallStore((s) => s.removeConnection)
  const resetCallStore = useCallStore((s) => s.reset)

  const wireOutgoingCall = useCallback(
    (call: MediaConnection) => {
      const peerId = call.peer
      setConnection(peerId, call)
      call.on('stream', (remoteStream) => {
        setRemoteStream(peerId, remoteStream)
      })
      call.on('close', () => {
        removeConnection(peerId)
        removeRemoteStream(peerId)
      })
    },
    [setConnection, setRemoteStream, removeConnection, removeRemoteStream]
  )

  const endCall = useCallback(() => {
    const state = useCallStore.getState()
    Object.values(state.connections).forEach((c) => closeMediaConnection(c))
    stopStreamTracks(state.localStream)
    resetCallStore()
  }, [resetCallStore])

  useEffect(() => {
    if (!userId) {
      setPeerReady(false)
      return
    }

    const peer = new Peer(userId, {
      config: ICE,
      debug: 0,
    })

    peer.on('open', () => setPeerReady(true))
    peer.on('error', () => setPeerReady(false))

    peer.on('call', (call: MediaConnection) => {
      const meta = call.metadata as { isVideo?: boolean } | undefined
      const state = useCallStore.getState()

      if (state.isCalling && state.localStream) {
        call.answer(state.localStream)
        wireOutgoingCall(call)
        return
      }

      setIncomingCall({
        peerId: call.peer,
        call,
        isVideo: meta?.isVideo,
      })
    })

    peerRef.current = peer

    return () => {
      setPeerReady(false)
      endCall()
      peer.destroy()
      peerRef.current = null
    }
  }, [userId, setIncomingCall, wireOutgoingCall, endCall])

  const rejectIncomingCall = useCallback(() => {
    const inc = useCallStore.getState().incomingCall
    if (inc) {
      closeMediaConnection(inc.call)
      setIncomingCall(null)
    }
  }, [setIncomingCall])

  const acceptIncomingCall = useCallback(async () => {
    const inc = useCallStore.getState().incomingCall
    if (!inc) return

    const wantVideo = inc.isVideo ?? true
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: wantVideo,
    })

    setLocalStream(stream)
    setIsCalling(true)
    setIncomingCall(null)

    inc.call.answer(stream)
    wireOutgoingCall(inc.call)
  }, [
    setIncomingCall,
    setIsCalling,
    setLocalStream,
    wireOutgoingCall,
  ])

  const initiateCall = useCallback(
    async (recipientIds: string[], isVideo: boolean) => {
      const peer = peerRef.current
      if (!peer || !peerReady) return

      const ids = Array.from(new Set(recipientIds)).filter(Boolean)
      if (ids.length === 0) return

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: isVideo,
      })

      setLocalStream(stream)
      setIsCalling(true)

      for (const rid of ids) {
        const call = peer.call(rid, stream, {
          metadata: { isVideo },
        })
        wireOutgoingCall(call)
      }
    },
    [peerReady, setIsCalling, setLocalStream, wireOutgoingCall]
  )

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
  chatId: string,
  myUserId: string
): Promise<string[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('chat_members')
    .select('user_id')
    .eq('chat_id', chatId)

  if (error || !data) return []
  return data.map((r) => r.user_id).filter((id) => id !== myUserId)
}
