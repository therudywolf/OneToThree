'use client'

import { X, MicOff, VideoOff, Volume2, VolumeX, Lock, Radio, MonitorUp, UserMinus } from 'lucide-react'
import { useCallStore, type PeerConnectionType } from '@/store/callStore'
import { useTranslation } from '@/hooks/use-translation'

export type ParticipantRow = {
  userId: string
  label: string
  isLocal?: boolean
  micMuted?: boolean
  camOff?: boolean
  screenSharing?: boolean
  speaking?: boolean
  connectionType?: PeerConnectionType
  connectionState?: string
  /** Link-invited guest — server-marked, shown as a badge. */
  isGuest?: boolean
}

/**
 * PROJECT 13 :: CALL_PARTICIPANTS_PANEL (shared by 1:1 and group)
 *
 * Participant management: who is in the call, their mic/cam state, transport,
 * and — for remote peers — a LOCAL volume slider + mute-for-me toggle
 * (callStore.peerVolumes / peerLocalMuted, applied by CallAudioSink, never
 * signalled to the peer).
 */
export function CallParticipantsPanel({
  rows,
  onClose,
  onKickGuest,
  onRemoveMember,
}: {
  rows: ParticipantRow[]
  onClose: () => void
  /** Remove a link-invited guest from the room (host/admin action). */
  onKickGuest?: (userId: string, label: string) => void
  /** Remove a MEMBER from the call. Absent when the caller has no authority. */
  onRemoveMember?: (userId: string, label: string) => void
}) {
  const { t } = useTranslation()
  const peerVolumes = useCallStore((s) => s.peerVolumes)
  const peerLocalMuted = useCallStore((s) => s.peerLocalMuted)
  const setPeerVolume = useCallStore((s) => s.setPeerVolume)
  const setPeerLocalMuted = useCallStore((s) => s.setPeerLocalMuted)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-void/95 font-mono backdrop-blur-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border-strong px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-neon-cyan">
          {t('groupCall.participants')} ({rows.length})
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-text-primary"
          aria-label={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 divide-y divide-border-strong/60 overflow-y-auto">
        {rows.map((row) => {
          const volume = peerVolumes[row.userId] ?? 1
          const localMuted = !!peerLocalMuted[row.userId]
          return (
            <div key={row.userId} className="space-y-2 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
                      row.speaking ? 'border-neon-cyan bg-neon-cyan/10' : 'border-border-strong bg-void'
                    }`}
                  >
                    <span className="text-[10px] uppercase text-text-muted">
                      {row.label.slice(0, 2)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-xs text-text-primary">
                      {row.label}
                      {row.isLocal ? (
                        <span className="ml-1.5 text-[9px] uppercase text-text-muted">
                          ({t('call.you')})
                        </span>
                      ) : null}
                      {row.isGuest ? (
                        <span className="ml-1.5 rounded bg-warning/20 px-1 py-0.5 text-[9px] uppercase text-warning">
                          {t('guest.badge')}
                        </span>
                      ) : null}
                    </p>
                    <p className="flex items-center gap-1.5 text-[9px] uppercase text-text-muted/70">
                      {row.connectionType === 'p2p' ? (
                        <span className="flex items-center gap-0.5 text-success"><Lock className="h-2.5 w-2.5" />P2P</span>
                      ) : row.connectionType === 'relay' ? (
                        <span className="flex items-center gap-0.5 text-accent-2"><Radio className="h-2.5 w-2.5" />RELAY</span>
                      ) : null}
                      {row.connectionState && row.connectionState !== 'connected' && row.connectionState !== 'completed' ? (
                        <span className={row.connectionState === 'failed' ? 'text-neon-red' : ''}>
                          {row.connectionState.toUpperCase()}
                        </span>
                      ) : null}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {row.screenSharing ? <MonitorUp className="h-3.5 w-3.5 text-neon-cyan" /> : null}
                  {row.micMuted ? <MicOff className="h-3.5 w-3.5 text-neon-red" /> : null}
                  {row.camOff ? <VideoOff className="h-3.5 w-3.5 text-text-muted/70" /> : null}
                  {row.speaking ? <span className="h-2 w-2 animate-pulse rounded-full bg-neon-cyan" /> : null}
                  {row.isGuest && !row.isLocal && onKickGuest ? (
                    <button
                      type="button"
                      onClick={() => onKickGuest(row.userId, row.label)}
                      className="flex h-7 w-7 items-center justify-center text-text-muted transition-colors hover:text-neon-red"
                      title={t('guest.kick')}
                      aria-label={t('guest.kick')}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {/* Removing a MEMBER — offered only where the caller has the
                      authority for it (the server re-checks, and says so). A
                      link guest keeps the guest-specific action above; the two
                      go through different endpoints because a guest has no
                      chat membership to reason about. */}
                  {!row.isGuest && !row.isLocal && onRemoveMember ? (
                    <button
                      type="button"
                      onClick={() => onRemoveMember(row.userId, row.label)}
                      className="flex h-7 w-7 items-center justify-center text-text-muted transition-colors hover:text-neon-red"
                      title={t('call.removeFromCall')}
                      aria-label={t('call.removeFromCall')}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>

              {!row.isLocal ? (
                <div className="flex items-center gap-2 pl-10">
                  <button
                    type="button"
                    onClick={() => setPeerLocalMuted(row.userId, !localMuted)}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center transition-colors ${
                      localMuted ? 'text-neon-red' : 'text-text-muted hover:text-text-primary'
                    }`}
                    title={localMuted ? t('call.unmuteForMe') : t('call.muteForMe')}
                    aria-label={localMuted ? t('call.unmuteForMe') : t('call.muteForMe')}
                    aria-pressed={localMuted}
                  >
                    {localMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(volume * 100)}
                    disabled={localMuted}
                    onChange={(e) => setPeerVolume(row.userId, Number(e.target.value) / 100)}
                    className="h-1 w-full cursor-pointer accent-[var(--neon-cyan,#0ff)] disabled:opacity-40"
                    aria-label={t('call.peerVolume')}
                  />
                  <span className="w-9 shrink-0 text-right text-[9px] text-text-muted">
                    {localMuted ? '0%' : `${Math.round(volume * 100)}%`}
                  </span>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
