'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The meeting room screen shared by both sides of a guest link:
 *   - the GUEST enters it after the host approves their knock
 *     (app/guest/call/[token]),
 *   - the HOST enters the same room from their own links list
 *     (app/meet/[room]).
 *
 * It owns everything from "I hold a LiveKit grant" onward: connect, publish the
 * mic, render tiles, mic/camera/leave controls, teardown. Both entry points
 * differ only in how they OBTAIN the grant, so keeping one implementation here
 * is what stops the two screens from drifting apart.
 *
 * LiveKit handling mirrors lib/livekit-call-manager.ts:
 *   - dynamic import('livekit-client') keeps the SDK out of the main bundle
 *   - E2EE via ExternalE2EEKeyProvider + new Worker('/livekit-e2ee-worker.js')
 *   - FAIL-CLOSED: when the server issued a room key, any provider/worker
 *     failure aborts the join instead of connecting plaintext-to-SFU
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomOptions,
} from 'livekit-client'
// The badge predicate comes from the call manager and is NOT re-implemented
// here: this screen used to carry its own byte-identical copy, and a copy is
// exactly how the "guest label is server-issued, never name-derived" property
// gets weakened on one screen while the test keeps passing on the other.
import { isGuestParticipant } from '@/lib/livekit-call-manager'
import { toastError } from '@/store/toastStore'
import { useTranslation } from '@/hooks/use-translation'

// ─── Lazy livekit-client module (kept out of the main bundle) ───────────────

type LkModule = typeof import('livekit-client')
let lkModule: LkModule | null = null
async function loadLk(): Promise<LkModule> {
  if (!lkModule) lkModule = await import('livekit-client')
  return lkModule
}

/** Decode base64 (standard or url-safe) to Uint8Array — same as the manager. */
function b64ToBytes(b64: string): Uint8Array {
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(standard)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

function displayName(p: RemoteParticipant): string {
  return p.name && p.name.length > 0 ? p.name : p.identity
}

// ─── Small UI atoms (shared with the guest entry screens) ───────────────────

export function CenterCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-950 px-4 text-neutral-100">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        {children}
      </div>
    </div>
  )
}

export function Spinner() {
  const { t } = useTranslation()
  return (
    <div
      className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-100"
      aria-label={t('common.loading')}
    />
  )
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      {off ? <path d="M4 4l16 16" stroke="currentColor" /> : null}
    </svg>
  )
}

function CamIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="7" width="12" height="10" rx="2" />
      <path d="M15 10l6-3v10l-6-3" />
      {off ? <path d="M3 4l18 16" /> : null}
    </svg>
  )
}

function LeaveIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

// ─── Remote media sinks ─────────────────────────────────────────────────────

function AudioSink({ track }: { track: RemoteTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track])
  return <audio ref={ref} autoPlay />
}

function ParticipantTile({
  participant,
  onKick,
}: {
  participant: RemoteParticipant
  /** Present only for a host who may remove guests. */
  onKick?: (identity: string, name: string) => void
}) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const lk = lkModule

  // Screen share wins the tile's video slot (it's the thing being shown);
  // otherwise the camera. All subscribed audio goes to hidden <audio> sinks.
  let videoPub: RemoteTrackPublication | undefined
  for (const pub of participant.videoTrackPublications.values()) {
    if (!pub.track) continue
    if (lk && pub.source === lk.Track.Source.ScreenShare) {
      videoPub = pub
      break
    }
    if (!videoPub) videoPub = pub
  }
  const audioTracks: { sid: string; track: RemoteTrack }[] = []
  for (const pub of participant.audioTrackPublications.values()) {
    if (pub.track) audioTracks.push({ sid: pub.trackSid, track: pub.track })
  }

  const videoTrack = videoPub?.track
  useEffect(() => {
    const el = videoRef.current
    if (!el || !videoTrack) return
    videoTrack.attach(el)
    return () => {
      videoTrack.detach(el)
    }
  }, [videoTrack])

  const name = displayName(participant)
  const guest = isGuestParticipant(participant.metadata)
  const micOff = !participant.isMicrophoneEnabled

  return (
    <div
      className={`relative flex min-h-[10rem] items-center justify-center overflow-hidden rounded-xl border bg-neutral-900 ${
        participant.isSpeaking ? 'border-emerald-500' : 'border-neutral-800'
      }`}
    >
      {videoTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-800 text-2xl font-semibold text-neutral-300">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {audioTracks.map(({ sid, track }) => (
        <AudioSink key={sid} track={track} />
      ))}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-neutral-950/70 px-2 py-1 text-xs">
        <span className="max-w-[10rem] truncate">{name}</span>
        {guest ? (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            {t('guest.badge')}
          </span>
        ) : null}
        {micOff ? (
          <span className="text-neutral-400">
            <MicIcon off />
          </span>
        ) : null}
      </div>
      {guest && onKick ? (
        <button
          type="button"
          onClick={() => onKick(participant.identity, name)}
          title={t('meet.kickGuestTitle').replace('{name}', name)}
          className="absolute right-2 top-2 rounded-md bg-neutral-950/70 px-2 py-1 text-xs text-neutral-300 transition hover:bg-red-600 hover:text-white"
        >
          {t('meet.kickGuestAction')}
        </button>
      ) : null}
    </div>
  )
}

// ─── The room stage ─────────────────────────────────────────────────────────

export type LiveKitGrant = {
  url: string
  token: string
  /** Base64 room key. When present, E2EE is MANDATORY (fail-closed). */
  e2eeKey?: string | null
}

type Props = {
  grant: LiveKitGrant
  /** Header line, e.g. "Встреча у Ани" or "Быстрая встреча". */
  title: string
  /** Label under the local tile; defaults to the localized "you". */
  selfLabel?: string
  /** Show the «гость» badge on the local tile (the guest's own view). */
  selfIsGuest?: boolean
  /** Host only: remove a link-invited guest from the room. */
  onKickGuest?: (identity: string) => Promise<void>
  /** The room ended: `left` distinguishes a voluntary leave from a kick/drop. */
  onEnded: (left: boolean) => void
  /** Setup/connect failed — the caller renders the message. */
  onError: (message: string) => void
}

export function LiveKitRoomStage({
  grant,
  title,
  selfLabel,
  selfIsGuest = false,
  onKickGuest,
  onEnded,
  onError,
}: Props) {
  const { t } = useTranslation()
  const selfName = selfLabel ?? t('meet.self')
  const [connected, setConnected] = useState(false)
  const [micEnabled, setMicEnabled] = useState(false)
  const [camOn, setCamOn] = useState(false)
  const [camBusy, setCamBusy] = useState(false)
  const [e2eeActive, setE2eeActive] = useState(false)
  const [kicking, setKicking] = useState<string | null>(null)
  // Bumped on every relevant RoomEvent so the tile grid re-renders.
  const [, setRoomVersion] = useState(0)

  const roomRef = useRef<Room | null>(null)
  const micTrackRef = useRef<LocalAudioTrack | null>(null)
  const camTrackRef = useRef<LocalVideoTrack | null>(null)
  const leavingRef = useRef(false)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  // The join runs once per grant; callbacks are read through refs so a parent
  // re-render never re-triggers it. `t` gets the same treatment — it changes
  // identity when the locale is switched, and a language toggle must never
  // tear down and redial a live room.
  const endedRef = useRef(onEnded)
  const errorRef = useRef(onError)
  const tRef = useRef(t)
  endedRef.current = onEnded
  errorRef.current = onError
  tRef.current = t

  useEffect(() => {
    let cancelled = false

    void (async () => {
      let lk: LkModule
      try {
        lk = await loadLk()
      } catch {
        errorRef.current(tRef.current('meet.moduleFailed'))
        return
      }
      if (cancelled) return

      const options: RoomOptions = { adaptiveStream: true, dynacast: true }

      // FAIL-CLOSED: the server issued a room key ⇒ frame encryption is
      // mandatory. If the provider or the worker cannot be set up, abort —
      // never connect plaintext-to-SFU.
      if (grant.e2eeKey) {
        try {
          const keyBytes = b64ToBytes(grant.e2eeKey)
          const provider = new lk.ExternalE2EEKeyProvider()
          await provider.setKey(keyBytes.buffer as ArrayBuffer)
          const worker = new Worker('/livekit-e2ee-worker.js')
          options.e2ee = { keyProvider: provider, worker }
        } catch {
          errorRef.current(tRef.current('meet.e2eeFailed'))
          return
        }
      }
      if (cancelled) return

      const room = new lk.Room(options)
      roomRef.current = room

      const bump = () => setRoomVersion((v) => v + 1)
      room
        .on(lk.RoomEvent.ParticipantConnected, bump)
        .on(lk.RoomEvent.ParticipantDisconnected, bump)
        .on(lk.RoomEvent.TrackSubscribed, bump)
        .on(lk.RoomEvent.TrackUnsubscribed, bump)
        .on(lk.RoomEvent.TrackMuted, bump)
        .on(lk.RoomEvent.TrackUnmuted, bump)
        .on(lk.RoomEvent.ParticipantMetadataChanged, bump)
        .on(lk.RoomEvent.ActiveSpeakersChanged, bump)
        .on(lk.RoomEvent.ConnectionStateChanged, bump)
        .on(lk.RoomEvent.Disconnected, () => {
          // Fires for both a voluntary leave and a server-side kick.
          micTrackRef.current?.stop()
          micTrackRef.current = null
          camTrackRef.current?.stop()
          camTrackRef.current = null
          setCamOn(false)
          roomRef.current = null
          endedRef.current(leavingRef.current)
        })

      try {
        await room.connect(grant.url, grant.token)
      } catch {
        roomRef.current = null
        try {
          await room.disconnect()
        } catch {
          /* never connected */
        }
        errorRef.current(tRef.current('meet.connectFailed'))
        return
      }
      if (cancelled) {
        void room.disconnect()
        return
      }

      setE2eeActive(Boolean(options.e2ee))

      // Audio-first: mic only; the camera is a toggle inside the call.
      try {
        const tracks = await lk.createLocalTracks({ audio: true, video: false })
        const mic = tracks.find((t) => t.kind === lk.Track.Kind.Audio) as
          | LocalAudioTrack
          | undefined
        if (mic) {
          await room.localParticipant.publishTrack(mic)
          micTrackRef.current = mic
          setMicEnabled(true)
        } else {
          setMicEnabled(false)
        }
      } catch {
        // No mic permission — you can still listen; the mic button retries.
        setMicEnabled(false)
      }

      setConnected(true)
      bump()
    })()

    return () => {
      cancelled = true
      micTrackRef.current?.stop()
      micTrackRef.current = null
      camTrackRef.current?.stop()
      camTrackRef.current = null
      const room = roomRef.current
      roomRef.current = null
      if (room) void room.disconnect()
    }
  }, [grant])

  const toggleMic = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const lp = room.localParticipant
    try {
      await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled)
    } catch {
      return
    }
    setMicEnabled(lp.isMicrophoneEnabled)
  }, [])

  const toggleCam = useCallback(async () => {
    const room = roomRef.current
    const lk = lkModule
    if (!room || !lk || camBusy) return
    setCamBusy(true)
    try {
      if (camTrackRef.current) {
        const track = camTrackRef.current
        camTrackRef.current = null
        try {
          await room.localParticipant.unpublishTrack(track, true)
        } catch {
          /* already gone */
        }
        track.stop()
        setCamOn(false)
      } else {
        const tracks = await lk.createLocalTracks({
          audio: false,
          video: { resolution: lk.VideoPresets.h720.resolution },
        })
        const cam = tracks.find((t) => t.kind === lk.Track.Kind.Video) as
          | LocalVideoTrack
          | undefined
        if (cam) {
          await room.localParticipant.publishTrack(cam)
          camTrackRef.current = cam
          setCamOn(true)
        }
      }
    } catch {
      camTrackRef.current?.stop()
      camTrackRef.current = null
      setCamOn(false)
    } finally {
      setCamBusy(false)
    }
  }, [camBusy])

  const leaveCall = useCallback(async () => {
    leavingRef.current = true
    micTrackRef.current?.stop()
    micTrackRef.current = null
    camTrackRef.current?.stop()
    camTrackRef.current = null
    setCamOn(false)
    const room = roomRef.current
    roomRef.current = null
    if (room) {
      try {
        await room.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    endedRef.current(true)
  }, [])

  const kickGuest = useCallback(
    async (identity: string, name: string) => {
      if (!onKickGuest) return
      if (!window.confirm(t('guest.kickConfirm').replace('{name}', name))) return
      setKicking(identity)
      try {
        await onKickGuest(identity)
      } catch (err) {
        // The tile staying put IS the whole symptom, so silence here read as
        // success: a 403 (someone else minted the link) and a kick the SFU
        // never applied both looked exactly like a slow removal. Same split
        // the in-chat call screen makes — not allowed vs. try again.
        const code = err instanceof Error ? err.message : ''
        toastError(code === 'FORBIDDEN' ? t('guest.kickForbidden') : t('guest.kickFailed'))
      } finally {
        setKicking(null)
      }
    },
    [onKickGuest, t]
  )

  // Local camera preview attach/detach.
  useEffect(() => {
    if (!camOn) return
    const el = localVideoRef.current
    const track = camTrackRef.current
    if (!el || !track) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [camOn])

  if (!connected) {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-4">
          <Spinner />
          <p className="text-sm text-neutral-400">{t('meet.connecting')}</p>
        </div>
      </CenterCard>
    )
  }

  const room = roomRef.current
  const remotes: RemoteParticipant[] = room
    ? Array.from(room.remoteParticipants.values())
    : []
  const participantCount = remotes.length + 1

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        <div className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
          {e2eeActive ? (
            <span
              className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300"
              title={t('meet.encryptedHint')}
            >
              {t('meet.encrypted')}
            </span>
          ) : null}
          <span>{t('meet.participants').replace('{n}', String(participantCount))}</span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-3">
        {remotes.length === 0 ? (
          <div className="flex h-full min-h-[10rem] items-center justify-center text-sm text-neutral-500">
            {t('meet.aloneHere')}
          </div>
        ) : null}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          {remotes.map((p) => (
            <ParticipantTile
              key={p.identity}
              participant={p}
              onKick={
                onKickGuest && kicking !== p.identity
                  ? (identity, name) => void kickGuest(identity, name)
                  : undefined
              }
            />
          ))}
          {/* Local tile: preview when the camera is on, avatar otherwise. */}
          <div className="relative flex min-h-[10rem] items-center justify-center overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
            {camOn ? (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full -scale-x-100 object-contain"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-800 text-2xl font-semibold text-neutral-300">
                {selfName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-neutral-950/70 px-2 py-1 text-xs">
              <span>{selfName}</span>
              {selfIsGuest ? (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  {t('guest.badge')}
                </span>
              ) : null}
              {!micEnabled ? (
                <span className="text-neutral-400">
                  <MicIcon off />
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </main>

      <footer className="flex items-center justify-center gap-3 border-t border-neutral-800 px-4 py-3">
        <button
          type="button"
          onClick={() => void toggleMic()}
          title={micEnabled ? t('meet.micOff') : t('meet.micOn')}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
            micEnabled
              ? 'bg-neutral-800 text-neutral-100 hover:bg-neutral-700'
              : 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
          }`}
        >
          <MicIcon off={!micEnabled} />
        </button>
        <button
          type="button"
          onClick={() => void toggleCam()}
          disabled={camBusy}
          title={camOn ? t('meet.camOff') : t('meet.camOn')}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition disabled:opacity-50 ${
            camOn
              ? 'bg-neutral-800 text-neutral-100 hover:bg-neutral-700'
              : 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
          }`}
        >
          <CamIcon off={!camOn} />
        </button>
        <button
          type="button"
          onClick={() => void leaveCall()}
          className="flex h-11 items-center gap-2 rounded-full bg-red-600 px-5 font-medium text-white transition hover:bg-red-500"
        >
          <LeaveIcon />
          <span className="text-sm">{t('meet.leave')}</span>
        </button>
      </footer>
    </div>
  )
}
