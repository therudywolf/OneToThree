'use client'

import { useGroupCallStore } from '@/store/groupCallStore'
import { useTranslation } from '@/hooks/use-translation'
import { FloatingCallWindow } from '@/components/call/call-floating-window'

type Props = {
  onExpand: () => void
  onEndCall: () => void
  onToggleMute: () => void
}

/**
 * Minimized group call — the shared draggable floating window. Previews the
 * dominant speaker's stream when someone has video, otherwise shows the room
 * size as the title.
 */
export function GroupCallMiniPlayer({ onExpand, onEndCall, onToggleMute }: Props) {
  const { t } = useTranslation()
  const isInGroupCall = useGroupCallStore((s) => s.isInGroupCall)
  const isMiniPlayer = useGroupCallStore((s) => s.isMiniPlayer)
  const participants = useGroupCallStore((s) => s.participants)
  const remoteStreams = useGroupCallStore((s) => s.remoteStreams)
  const localStream = useGroupCallStore((s) => s.localStream)
  const callStartTime = useGroupCallStore((s) => s.callStartTime)


  if (!isInGroupCall || !isMiniPlayer) return null

  const totalCount = Object.keys(participants).length + 1
  const audioMuted = localStream?.getAudioTracks().some((t_) => !t_.enabled) ?? false

  // Prefer the speaking participant's stream, else the first remote.
  const speakingId = Object.values(participants).find((p) => p.isSpeaking)?.userId
  const previewStream =
    (speakingId ? remoteStreams[speakingId] : null) ??
    Object.values(remoteStreams)[0] ??
    null

  return (
    <FloatingCallWindow
      stream={previewStream}
      title={`${t('groupCall.title')} · ${totalCount}`}
      startedAt={callStartTime}
      micMuted={audioMuted}
      onExpand={onExpand}
      onToggleMute={onToggleMute}
      onEndCall={onEndCall}
    />
  )
}
