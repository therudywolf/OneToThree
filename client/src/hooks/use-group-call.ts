'use client'

import { useEffect, useCallback } from 'react'
import { getFmSocket } from '@/lib/api/socket'
import { useGroupCallStore } from '@/store/groupCallStore'
import {
  joinGroupCall,
  leaveGroupCall,
  handleParticipantList,
  handleMemberJoin,
  handleMemberLeave,
  handleGroupCallOffer,
  handleGroupCallAnswer,
  handleGroupCallIce,
  handleMuteChange,
  handleVideoToggle,
  handleSpeakingChange,
  handleGroupCallRelayFrame,
  toggleGroupCallMute,
  toggleGroupCallVideo,
  startGroupCallScreenShare,
  stopGroupCallScreenShare,
  isGroupCallScreenSharing,
  isGroupCallCameraOn,
} from '@/lib/group-call-manager'

/**
 * PROJECT 13 :: GROUP_CALL_HOOK
 * Level: Interface Layer (React Integration)
 *
 * Subscribes to WebSocket group call events and provides call control actions.
 */
export function useGroupCall(userId: string | null) {
  const isInGroupCall = useGroupCallStore((s) => s.isInGroupCall)
  const roomId = useGroupCallStore((s) => s.roomId)
  const localStream = useGroupCallStore((s) => s.localStream)
  const remoteStreams = useGroupCallStore((s) => s.remoteStreams)
  const participants = useGroupCallStore((s) => s.participants)
  const isVideo = useGroupCallStore((s) => s.isVideo)
  const activeCallBanner = useGroupCallStore((s) => s.activeCallBanner)

  // Wire up WS subscription for group call events
  useEffect(() => {
    if (!userId) return

    const socket = getFmSocket()
    return socket.subscribe(async (msg) => {
      switch (msg.type) {
        case 'group_call:participant_list':
          await handleParticipantList(msg.room_id, msg.participants, userId)
          break

        case 'group_call:member_join':
          handleMemberJoin(msg.room_id, msg.user_id, msg.username)
          break

        case 'group_call:member_leave':
          handleMemberLeave(msg.room_id, msg.user_id)
          break

        case 'group_call:offer':
          await handleGroupCallOffer(
            msg.room_id,
            msg.from_user_id,
            msg.sdp,
            msg.is_video
          )
          break

        case 'group_call:answer':
          await handleGroupCallAnswer(msg.room_id, msg.from_user_id, msg.sdp)
          break

        case 'group_call:ice':
          await handleGroupCallIce(msg.room_id, msg.from_user_id, msg.candidate)
          break

        case 'group_call:mute':
          handleMuteChange(msg.room_id, msg.user_id, msg.is_muted)
          break

        case 'group_call:video_toggle':
          handleVideoToggle(msg.room_id, msg.user_id, msg.is_video_off)
          break

        case 'group_call:speaking':
          handleSpeakingChange(msg.room_id, msg.user_id, msg.is_speaking)
          break

        case 'group_call:relay_frame':
          await handleGroupCallRelayFrame(
            msg.room_id,
            msg.from_user_id,
            msg.ciphertext,
            msg.iv,
            msg.sample_rate,
            typeof msg.seq === 'number' ? msg.seq : null
          )
          break

        case 'group_call:active':
          useGroupCallStore
            .getState()
            .setActiveCallBanner(msg.room_id, msg.participant_count)
          break

        case 'group_call:ended':
          useGroupCallStore.getState().clearActiveCallBanner(msg.room_id)
          break
      }
    })
  }, [userId])

  const startCall = useCallback(
    async (targetRoomId: string, withVideo: boolean) => {
      return joinGroupCall(targetRoomId, withVideo)
    },
    []
  )

  const endCall = useCallback(() => {
    leaveGroupCall()
  }, [])

  const toggleMute = useCallback(() => {
    toggleGroupCallMute()
  }, [])

  /**
   * Toggle the local camera. Flips the dedicated camera track only — never the
   * screen track; the first opt-in lazily acquires the camera. Returns the
   * resulting camera state so the UI can stay in sync (flipping `enabled` does
   * not re-render React on its own).
   */
  const toggleVideo = useCallback(async () => {
    await toggleGroupCallVideo()
    return isGroupCallCameraOn()
  }, [])

  /**
   * Toggle screen-share. Starting acquires the screen via getDisplayMedia only
   * (never the camera); stopping restores the prior camera state. Returns the
   * resulting screen-sharing state so the UI can sync its indicator.
   */
  const toggleScreenShare = useCallback(async () => {
    if (isGroupCallScreenSharing()) {
      stopGroupCallScreenShare()
      return false
    }
    return startGroupCallScreenShare()
  }, [])

  return {
    isInGroupCall,
    roomId,
    localStream,
    remoteStreams,
    participants,
    isVideo,
    activeCallBanner,
    startCall,
    endCall,
    toggleMute,
    toggleVideo,
    toggleScreenShare,
  }
}
