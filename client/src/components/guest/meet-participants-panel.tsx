'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * PROJECT 13 :: MEET_PARTICIPANTS_PANEL
 *
 * Who is in the meeting, and the two controls people actually reach for when
 * someone is too loud or too close to a microphone: a per-person volume and a
 * mute-for-me. Plus the host's kick, where the host has one.
 *
 * Deliberately NOT `components/call/call-participants-panel.tsx`, which reads
 * its volumes out of `callStore` and has them applied by `CallAudioSink`. This
 * screen runs with no app stores at all — a link guest has no session, no
 * vault and no chat — so the state lives in the stage's own React state and is
 * applied straight to the `<audio>` element playing that participant.
 *
 * "Mute for me" is local and is never signalled: the person you silence has no
 * way to know, which is the point. Muting THEM for everyone is the host's kick.
 */

import { useTranslation } from '@/hooks/use-translation'

export type MeetParticipantRow = {
  /** LiveKit identity — the key for volume, mute and kick alike. */
  identity: string
  label: string
  isLocal: boolean
  isGuest: boolean
  micMuted: boolean
  camOff: boolean
  screenSharing: boolean
  speaking: boolean
  /** LiveKit's own 0–3 quality enum, already mapped to a word. */
  quality?: 'excellent' | 'good' | 'poor' | 'unknown'
}

/**
 * Three hues, deliberately not theme tokens — most palettes in this repo define
 * `--success` and `--neon-amber` as the same value, so "fine" and "degrading"
 * would render identically. Same reasoning as DOT_COLORS in the call overlay.
 */
const QUALITY_DOT: Record<string, string> = {
  excellent: 'bg-[#22c55e]',
  good: 'bg-[#f59e0b]',
  poor: 'bg-neon-red',
  unknown: 'bg-text-muted/40',
}

export function MeetParticipantsPanel({
  rows,
  volumes,
  muted,
  onVolume,
  onToggleMuted,
  onKick,
  onClose,
}: {
  rows: MeetParticipantRow[]
  /** identity → 0..1. Absent means 1. */
  volumes: Record<string, number>
  /** identity → silenced for me. */
  muted: Record<string, boolean>
  onVolume: (identity: string, value: number) => void
  onToggleMuted: (identity: string) => void
  /** Absent when this viewer may not remove anyone. */
  onKick?: (identity: string, label: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-l border-border-strong bg-void/95 backdrop-blur-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border-strong px-3 py-2">
        <span className="text-xs uppercase tracking-[0.15em] text-neon-cyan">
          {t('groupCall.participants')} ({rows.length})
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-text-primary"
          aria-label={t('common.close')}
        >
          <CloseIcon />
        </button>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-border-strong/60 overflow-y-auto">
        {rows.map((row) => {
          const volume = volumes[row.identity] ?? 1
          const isMuted = !!muted[row.identity]
          return (
            <div key={row.identity} className="space-y-2 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs ${
                      row.speaking
                        ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                        : 'border-border-strong bg-void text-text-muted'
                    }`}
                  >
                    {row.label.slice(0, 2).toUpperCase()}
                  </div>
                  <p className="flex min-w-0 items-center gap-1.5 truncate text-sm text-text-primary">
                    <span className="truncate">{row.label}</span>
                    {row.isLocal ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted">
                        {t('meet.self')}
                      </span>
                    ) : null}
                    {row.isGuest ? (
                      <span className="shrink-0 rounded bg-neon-amber/20 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-neon-amber">
                        {t('guest.badge')}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full ${QUALITY_DOT[row.quality ?? 'unknown']}`}
                    title={t('call.connectionQuality')}
                  />
                  {row.screenSharing ? <ScreenBadge /> : null}
                  {row.micMuted ? <MutedBadge /> : null}
                  {!row.isLocal && onKick && row.isGuest ? (
                    <button
                      type="button"
                      onClick={() => onKick(row.identity, row.label)}
                      className="flex h-7 w-7 items-center justify-center text-text-muted transition-colors hover:text-neon-red"
                      title={t('guest.kick')}
                      aria-label={t('guest.kick')}
                    >
                      <KickIcon />
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Volume is meaningless for yourself — you are not played back. */}
              {!row.isLocal ? (
                <div className="flex items-center gap-2 pl-10">
                  <button
                    type="button"
                    onClick={() => onToggleMuted(row.identity)}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center transition-colors ${
                      isMuted ? 'text-neon-red' : 'text-text-muted hover:text-text-primary'
                    }`}
                    title={isMuted ? t('call.unmuteForMe') : t('call.muteForMe')}
                    aria-label={isMuted ? t('call.unmuteForMe') : t('call.muteForMe')}
                    aria-pressed={isMuted}
                  >
                    {isMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(volume * 100)}
                    disabled={isMuted}
                    onChange={(e) => onVolume(row.identity, Number(e.target.value) / 100)}
                    className="h-1 w-full cursor-pointer accent-[var(--neon-cyan,#0ff)] disabled:opacity-40"
                    aria-label={`${t('call.peerVolume')} — ${row.label}`}
                  />
                  <span className="w-9 shrink-0 text-right font-mono text-[10px] text-text-muted">
                    {Math.round(volume * 100)}%
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

// Inline icons, matching the rest of this screen: the guest bundle carries no
// icon library, and pulling one in for four glyphs is not worth the bytes on a
// page a stranger loads once.

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  )
}

function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M22 9l-6 6M16 9l6 6" />
    </svg>
  )
}

function ScreenBadge() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-neon-cyan" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

function MutedBadge() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-neon-red" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" />
    </svg>
  )
}

function KickIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M17 11h6" />
    </svg>
  )
}
