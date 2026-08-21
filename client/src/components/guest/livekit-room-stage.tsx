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
} from 'react'
import type {
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
// Re-exported, not defined here: the card is a leaf component (see
// center-card.tsx) so the temp-chat screens can use it without importing this
// module's call pipeline. Kept as a re-export because the guest call screens
// import both from here in one statement.
// This module also USES them (the connecting / failed states below), so import
// and re-export rather than a bare `export … from`.
import { CenterCard, Spinner } from '@/components/guest/center-card'

export { CenterCard, Spinner }
import {
  applyPreferredAudioOutput,
  loadCamEffectImage,
  loadMediaPrefs,
  MEDIA_PREFS_CHANGED_EVENT,
} from '@/lib/media-devices'
import { acquireMedia } from '@/lib/media-capture'
import { upgradeLocalStreamAudio, type VoiceProcessingHandle } from '@/lib/voice-processing'
import { createEffectedCameraTrack, type CameraEffectsHandle } from '@/lib/camera-effects'
import { MediaDeviceSettings } from '@/components/media/media-device-settings'
import { tracksAffectedBy, type MediaPrefKind } from '@/lib/media-device-list'

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

/** `wide` is for the pre-join check, which carries a video preview. */
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

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
    // Route to the chosen speaker. Every sink has to be told separately — a
    // sink created later (someone joins mid-meeting) would otherwise land on
    // the system default while the rest of the room plays where it was asked to.
    void applyPreferredAudioOutput(el)
    const onPrefs = () => void applyPreferredAudioOutput(el)
    window.addEventListener(MEDIA_PREFS_CHANGED_EVENT, onPrefs)
    return () => {
      window.removeEventListener(MEDIA_PREFS_CHANGED_EVENT, onPrefs)
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
      className={`relative flex min-h-[10rem] items-center justify-center overflow-hidden rounded-xl border bg-surface-elevated ${
        participant.isSpeaking ? 'border-success' : 'border-border-strong'
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
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-elevated text-2xl font-semibold text-text-primary">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {audioTracks.map(({ sid, track }) => (
        <AudioSink key={sid} track={track} />
      ))}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-void/70 px-2 py-1 text-xs">
        <span className="max-w-[10rem] truncate">{name}</span>
        {guest ? (
          <span className="rounded bg-neon-amber/20 px-1.5 py-0.5 text-[10px] font-medium text-neon-amber">
            {t('guest.badge')}
          </span>
        ) : null}
        {micOff ? (
          <span className="text-text-muted">
            <MicIcon off />
          </span>
        ) : null}
      </div>
      {guest && onKick ? (
        <button
          type="button"
          onClick={() => onKick(participant.identity, name)}
          title={t('meet.kickGuestTitle').replace('{name}', name)}
          className="absolute right-2 top-2 rounded-md bg-void/70 px-2 py-1 text-xs text-text-primary transition hover:bg-neon-red hover:text-text-primary"
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Bumped on every relevant RoomEvent so the tile grid re-renders.
  const [, setRoomVersion] = useState(0)

  const roomRef = useRef<Room | null>(null)
  /** Raw capture streams, kept so the hardware is released on teardown. */
  const micStreamRef = useRef<MediaStream | null>(null)
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  const voiceRef = useRef<VoiceProcessingHandle | null>(null)
  const camRawRef = useRef<MediaStreamTrack | null>(null)
  const camTrackRef = useRef<MediaStreamTrack | null>(null)
  const camFxRef = useRef<CameraEffectsHandle | null>(null)
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
      //
      // Not `createLocalTracks`: that ignores the saved device and the voice
      // chain, so a guest with a headset selected in Settings was published
      // from the laptop's built-in microphone. Same acquisition the members'
      // SFU path uses — saved device + echo/noise/AGC at capture, then the
      // noise-gate worklet — published as a custom track.
      try {
        const stream = await acquireMedia({ video: false, audio: true })
        micStreamRef.current = stream
        try {
          voiceRef.current = await upgradeLocalStreamAudio(stream)
        } catch {
          voiceRef.current = null
        }
        const mic = stream.getAudioTracks()[0] ?? null
        if (mic) {
          await room.localParticipant.publishTrack(mic, {
            source: lk.Track.Source.Microphone,
          })
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
      voiceRef.current?.dispose()
      voiceRef.current = null
      micStreamRef.current?.getTracks().forEach((tr) => tr.stop())
      micStreamRef.current = null
      micTrackRef.current = null
      camFxRef.current?.dispose()
      camFxRef.current = null
      camRawRef.current?.stop()
      camRawRef.current = null
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

  /** Drop the published camera and release the hardware (LED out). */
  const stopCamera = useCallback(async () => {
    const room = roomRef.current
    const track = camTrackRef.current
    camTrackRef.current = null
    if (room && track) {
      try {
        await room.localParticipant.unpublishTrack(track, true)
      } catch {
        /* already gone */
      }
    }
    // dispose() stops the raw track too; when there is no effects chain the
    // published track IS the raw one, hence the separate stop below.
    camFxRef.current?.dispose()
    camFxRef.current = null
    camRawRef.current?.stop()
    camRawRef.current = null
    track?.stop()
  }, [])

  /**
   * Acquire the camera the way the members' SFU path does — saved device and
   * resolution from the prefs, then the background effect — and publish it.
   */
  const startCamera = useCallback(async () => {
    const room = roomRef.current
    const lk = lkModule
    if (!room || !lk) return
    const prefs = loadMediaPrefs()
    const gum = await acquireMedia({ video: true, audio: false })
    const raw = gum.getVideoTracks()[0] ?? null
    if (!raw) return
    camRawRef.current = raw
    let publish: MediaStreamTrack = raw
    if (prefs.camEffect !== 'none') {
      try {
        const fx = await createEffectedCameraTrack(raw, {
          kind: prefs.camEffect,
          imageDataUrl: loadCamEffectImage(),
          blurPx: prefs.camBlurPx,
        })
        if (fx) {
          camFxRef.current = fx
          publish = fx.processedTrack
        }
      } catch {
        /* effects unavailable — publish the plain camera rather than nothing */
      }
    }
    await room.localParticipant.publishTrack(publish, {
      source: lk.Track.Source.Camera,
    })
    camTrackRef.current = publish
    setCamOn(true)
  }, [])

  const toggleCam = useCallback(async () => {
    const room = roomRef.current
    const lk = lkModule
    if (!room || !lk || camBusy) return
    setCamBusy(true)
    try {
      if (camTrackRef.current) {
        await stopCamera()
        setCamOn(false)
      } else {
        await startCamera()
      }
    } catch {
      await stopCamera()
      setCamOn(false)
    } finally {
      setCamBusy(false)
    }
  }, [camBusy, startCamera, stopCamera])

  /**
   * Apply a settings change to the LIVE session.
   *
   * Republish only what the change invalidates — `tracksAffectedBy` decides —
   * so picking a speaker touches no published media and swapping a background
   * never drops the microphone. A background change on an existing chain is a
   * live swap, not a re-acquire: tearing the camera down would blink the LED
   * and flash a black tile at everyone in the room.
   */
  const onPrefChange = useCallback(
    async (kind: MediaPrefKind) => {
      const affected = tracksAffectedBy(kind)
      if (affected.output) return // AudioSink re-routes itself on the prefs event

      if (affected.camera && camTrackRef.current) {
        if (kind === 'background' && camFxRef.current) {
          const prefs = loadMediaPrefs()
          camFxRef.current.setEffect(prefs.camEffect, loadCamEffectImage())
          return
        }
        setCamBusy(true)
        try {
          await stopCamera()
          await startCamera()
        } catch {
          await stopCamera()
          setCamOn(false)
        } finally {
          setCamBusy(false)
        }
        return
      }

      if (affected.mic && micTrackRef.current) {
        const room = roomRef.current
        const lk = lkModule
        if (!room || !lk) return
        const previous = micTrackRef.current
        try {
          await room.localParticipant.unpublishTrack(previous, true)
        } catch {
          /* already gone */
        }
        voiceRef.current?.dispose()
        voiceRef.current = null
        micStreamRef.current?.getTracks().forEach((tr) => tr.stop())
        micStreamRef.current = null
        micTrackRef.current = null
        try {
          const stream = await acquireMedia({ video: false, audio: true })
          micStreamRef.current = stream
          try {
            voiceRef.current = await upgradeLocalStreamAudio(stream)
          } catch {
            voiceRef.current = null
          }
          const mic = stream.getAudioTracks()[0] ?? null
          if (!mic) {
            setMicEnabled(false)
            return
          }
          await room.localParticipant.publishTrack(mic, {
            source: lk.Track.Source.Microphone,
          })
          micTrackRef.current = mic
          setMicEnabled(true)
        } catch {
          // The new device did not open. Say so rather than leaving a dead
          // button: the old track is already gone and cannot be restored.
          setMicEnabled(false)
        }
      }
    },
    [startCamera, stopCamera]
  )

  const leaveCall = useCallback(async () => {
    leavingRef.current = true
    // Release the hardware before the socket: a stranger watching their own
    // camera LED is the only confirmation they get that we let go.
    voiceRef.current?.dispose()
    voiceRef.current = null
    micStreamRef.current?.getTracks().forEach((tr) => tr.stop())
    micStreamRef.current = null
    micTrackRef.current = null
    camFxRef.current?.dispose()
    camFxRef.current = null
    camRawRef.current?.stop()
    camRawRef.current = null
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

  // Local camera preview. The published track is a plain MediaStreamTrack now
  // (it comes out of the effects chain, not out of livekit-client), so it is
  // wired by srcObject rather than the SDK's attach/detach. camBusy is in the
  // deps because a device or background swap replaces the track underneath a
  // camOn that never changed.
  useEffect(() => {
    if (!camOn) return
    const el = localVideoRef.current
    const track = camTrackRef.current
    if (!el || !track) return
    el.srcObject = new MediaStream([track])
    void el.play().catch(() => {})
    return () => {
      el.srcObject = null
    }
  }, [camOn, camBusy])

  if (!connected) {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-4">
          <Spinner />
          <p className="text-sm text-text-muted">{t('meet.connecting')}</p>
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
    <div className="flex h-dvh flex-col bg-void text-text-primary">
      <header className="flex items-center justify-between gap-3 border-b border-border-strong px-4 py-3">
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        <div className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
          {e2eeActive ? (
            <span
              className="rounded bg-success/15 px-1.5 py-0.5 text-success"
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
          <div className="flex h-full min-h-[10rem] items-center justify-center text-sm text-text-muted">
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
          <div className="relative flex min-h-[10rem] items-center justify-center overflow-hidden rounded-xl border border-border-strong bg-surface-elevated">
            {camOn ? (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full -scale-x-100 object-contain"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-elevated text-2xl font-semibold text-text-primary">
                {selfName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-void/70 px-2 py-1 text-xs">
              <span>{selfName}</span>
              {selfIsGuest ? (
                <span className="rounded bg-neon-amber/20 px-1.5 py-0.5 text-[10px] font-medium text-neon-amber">
                  {t('guest.badge')}
                </span>
              ) : null}
              {!micEnabled ? (
                <span className="text-text-muted">
                  <MicIcon off />
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </main>

      <footer className="flex items-center justify-center gap-3 border-t border-border-strong px-4 py-3">
        <button
          type="button"
          onClick={() => void toggleMic()}
          title={micEnabled ? t('meet.micOff') : t('meet.micOn')}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
            micEnabled
              ? 'bg-surface-elevated text-text-primary hover:bg-neon-cyan/10'
              : 'bg-neon-red/20 text-neon-red hover:bg-neon-red/30'
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
              ? 'bg-surface-elevated text-text-primary hover:bg-neon-cyan/10'
              : 'bg-neon-red/20 text-neon-red hover:bg-neon-red/30'
          }`}
        >
          <CamIcon off={!camOn} />
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
          title={settingsOpen ? t('meet.settingsClose') : t('meet.settings')}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
            settingsOpen
              ? 'bg-neon-cyan/10 text-text-primary'
              : 'bg-surface-elevated text-text-primary hover:bg-neon-cyan/10'
          }`}
        >
          <GearIcon />
        </button>
        <button
          type="button"
          onClick={() => void leaveCall()}
          className="flex h-11 items-center gap-2 rounded-full bg-neon-red px-5 font-medium text-text-primary transition hover:bg-neon-red/80"
        >
          <LeaveIcon />
          <span className="text-sm">{t('meet.leave')}</span>
        </button>
      </footer>

      {settingsOpen ? (
        <div className="border-t border-border-strong bg-void px-4 py-4">
          <div className="mx-auto max-w-md">
            <MediaDeviceSettings onChange={(kind) => void onPrefChange(kind)} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
