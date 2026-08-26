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
  applyScreenTrackSettings,
  getDisplayMediaOptions,
  getScreenShareMaxBitrateBps,
  loadCamEffectImage,
  loadMediaPrefs,
  MEDIA_PREFS_CHANGED_EVENT,
} from '@/lib/media-devices'
import { acquireMedia } from '@/lib/media-capture'
import { upgradeLocalStreamAudio, type VoiceProcessingHandle } from '@/lib/voice-processing'
import { createEffectedCameraTrack, type CameraEffectsHandle } from '@/lib/camera-effects'
import { MediaDeviceSettings } from '@/components/media/media-device-settings'
import { CallTile } from '@/components/call/call-tile'
import { MeetParticipantsPanel, type MeetParticipantRow } from '@/components/guest/meet-participants-panel'
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

function ScreenIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      {off ? <path d="M3 3l18 18" /> : null}
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

function AudioSink({ track, volume = 1 }: { track: RemoteTrack; volume?: number }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  // Per-person volume and mute-for-me, applied to the element rather than
  // signalled: the person you turn down never learns that you did, which is
  // the whole point of the control. Kept in its own effect so changing a
  // slider does not detach and re-attach the track.
  useEffect(() => {
    const el = ref.current
    if (el) el.volume = Math.max(0, Math.min(1, volume))
  }, [volume])
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

/** Identity used for the local participant's own rows — never a real one. */
const LOCAL_KEY = '@self'

/** One tile = one video source, so a presenter with their camera on gets two. */
type StageTile = {
  key: string
  identity: string
  label: string
  stream: MediaStream | null
  isLocal: boolean
  isScreen: boolean
  isGuest: boolean
  micMuted: boolean
  camOff: boolean
  speaking: boolean
}

/**
 * What the spotlight falls on when nobody has pinned anything: a shared screen
 * first (it is the thing being shown), then whoever is speaking, then the first
 * remote camera. Falls back to our own tile in a room of one.
 */
function autoSpotlightKey(tiles: StageTile[]): string | undefined {
  return (
    tiles.find((tile) => tile.isScreen)?.key ??
    tiles.find((tile) => tile.speaking && !tile.isLocal)?.key ??
    tiles.find((tile) => !tile.isLocal)?.key ??
    tiles[0]?.key
  )
}

/** LiveKit's ConnectionQuality enum → a word the panel can colour. */
function qualityWord(
  lk: LkModule | null,
  quality: unknown
): 'excellent' | 'good' | 'poor' | 'unknown' {
  if (!lk || quality === undefined) return 'unknown'
  const q = lk.ConnectionQuality
  if (quality === q.Excellent) return 'excellent'
  if (quality === q.Good) return 'good'
  if (quality === q.Poor) return 'poor'
  return 'unknown'
}

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
  /** Screen share, WITH its audio (#4) — the temp call had neither. */
  const [screenOn, setScreenOn] = useState(false)
  const [screenBusy, setScreenBusy] = useState(false)
  const [e2eeActive, setE2eeActive] = useState(false)
  const [kicking, setKicking] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [layout, setLayout] = useState<'grid' | 'spotlight'>('spotlight')
  const [pinnedKey, setPinnedKey] = useState<string | null>(null)
  /** identity -> 0..1, and identity -> silenced for me. Local, never signalled. */
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>({})
  const [peerMuted, setPeerMuted] = useState<Record<string, boolean>>({})
  /**
   * Bumped whenever a LOCAL track is swapped underneath a flag that did not
   * change (device or background switch while the camera stays on). Script-side
   * track changes fire no events, so the tile needs the nudge.
   */
  const [localMediaRev, setLocalMediaRev] = useState(0)
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
  const screenTrackRef = useRef<MediaStreamTrack | null>(null)
  const screenAudioTrackRef = useRef<MediaStreamTrack | null>(null)
  const leavingRef = useRef(false)
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
        // The quality dot in the participants panel is only as live as this.
        .on(lk.RoomEvent.ConnectionQualityChanged, bump)
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

  /**
   * Screen share for the temp call (#4).
   *
   * The stripped-down stage could show a face and nothing else — a meeting
   * where you cannot show what you are talking about is half a meeting, and
   * "captured the call with sound" was flatly impossible.
   *
   * Published by hand rather than through `setScreenShareEnabled` so the app's
   * own preferences apply — resolution, frame rate, and system audio, which is
   * the half that was missing. The audio track goes up as its own
   * ScreenShareAudio publication (LiveKit routes it separately) and the encoder
   * gets the budget the chosen preset actually needs; the default ~2.5 Mbps is
   * not a 1080p60 desktop.
   */
  const stopScreenShare = useCallback(async () => {
    const room = roomRef.current
    for (const ref of [screenTrackRef, screenAudioTrackRef]) {
      const track = ref.current
      ref.current = null
      if (!track) continue
      try {
        await room?.localParticipant.unpublishTrack(track)
      } catch {
        /* already gone with the room — stopping the track is what matters */
      }
      track.stop()
    }
    setScreenOn(false)
  }, [])

  const startScreenShare = useCallback(async () => {
    const room = roomRef.current
    const lk = lkModule
    if (!room || !lk) return
    const stream = await navigator.mediaDevices.getDisplayMedia(getDisplayMediaOptions())
    const video = stream.getVideoTracks()[0] ?? null
    const audio = stream.getAudioTracks()[0] ?? null
    if (!video) {
      stream.getTracks().forEach((tr) => tr.stop())
      return
    }
    applyScreenTrackSettings(video)
    const prefs = loadMediaPrefs()
    await room.localParticipant.publishTrack(video, {
      source: lk.Track.Source.ScreenShare,
      videoEncoding: {
        maxBitrate: getScreenShareMaxBitrateBps(prefs.screenRes, prefs.screenFps),
        maxFramerate: prefs.screenFps === 'source' ? undefined : Number(prefs.screenFps),
      },
    })
    screenTrackRef.current = video
    if (audio) {
      await room.localParticipant.publishTrack(audio, {
        source: lk.Track.Source.ScreenShareAudio,
      })
      screenAudioTrackRef.current = audio
    }
    // "Stop sharing" from the browser's own control must not leave a dead
    // publication behind — the tile would sit there frozen for everyone else.
    video.onended = () => { void stopScreenShare() }
    setScreenOn(true)
  }, [stopScreenShare])

  const toggleScreen = useCallback(async () => {
    if (screenBusy) return
    setScreenBusy(true)
    try {
      if (screenTrackRef.current) await stopScreenShare()
      else await startScreenShare()
    } catch (err) {
      // A dismissed picker is a decision, not a failure.
      if ((err as Error)?.name !== 'NotAllowedError') toastError(t('call.screenShareFailed'))
      await stopScreenShare()
    } finally {
      setScreenBusy(false)
    }
  }, [screenBusy, startScreenShare, stopScreenShare, t])

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
    // The screen capture is hardware too — a share left running past the call
    // keeps the browser's "you are sharing" bar up over an empty room.
    screenTrackRef.current?.stop()
    screenTrackRef.current = null
    screenAudioTrackRef.current?.stop()
    screenAudioTrackRef.current = null
    setScreenOn(false)
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

  /**
   * Nudge the local tiles when a track was swapped underneath a flag that did
   * not change — a device or background switch while the camera stays on. The
   * tile compares `srcObject` by reference and the swap fires no event of its
   * own, so without this the tile keeps playing the track that was replaced.
   */
  useEffect(() => {
    setLocalMediaRev((v) => v + 1)
  }, [camOn, camBusy, screenOn])

  // ── Tile model ───────────────────────────────────────────────────────────
  //
  // One tile per VIDEO SOURCE, not per participant, so someone presenting with
  // their camera on appears twice — the way the app's own call screens have
  // shown it since dual capture landed.
  //
  // The MediaStream handed to a tile has to keep its IDENTITY across renders:
  // <video>.srcObject is compared by reference, so a fresh `new MediaStream()`
  // every render would detach and re-attach the element on every keystroke
  // elsewhere in the tree — a visible black flash per re-render. Cached by
  // track id, rebuilt only when the underlying track actually changes.
  const streamsRef = useRef(new Map<string, { trackId: string; stream: MediaStream }>())
  const stableStream = (key: string, track: MediaStreamTrack | null): MediaStream | null => {
    if (!track) {
      streamsRef.current.delete(key)
      return null
    }
    const cached = streamsRef.current.get(key)
    if (cached && cached.trackId === track.id) return cached.stream
    const stream = new MediaStream([track])
    streamsRef.current.set(key, { trackId: track.id, stream })
    return stream
  }

  const room = roomRef.current
  const lk = lkModule
  const remotes: RemoteParticipant[] = room
    ? Array.from(room.remoteParticipants.values())
    : []

  const tiles: StageTile[] = []
  const participantRows: MeetParticipantRow[] = []
  const audioSinks: { sid: string; identity: string; track: RemoteTrack }[] = []

  for (const participant of remotes) {
    let camera: MediaStreamTrack | null = null
    let screen: MediaStreamTrack | null = null
    for (const pub of participant.videoTrackPublications.values()) {
      const media = pub.track?.mediaStreamTrack ?? null
      if (!media) continue
      if (lk && pub.source === lk.Track.Source.ScreenShare) screen ??= media
      else camera ??= media
    }
    for (const pub of participant.audioTrackPublications.values()) {
      if (pub.track) audioSinks.push({ sid: pub.trackSid, identity: participant.identity, track: pub.track })
    }

    const name = displayName(participant)
    const guest = isGuestParticipant(participant.metadata)
    const micOff = !participant.isMicrophoneEnabled

    tiles.push({
      key: participant.identity,
      identity: participant.identity,
      label: name,
      stream: stableStream(participant.identity, camera),
      isLocal: false,
      isScreen: false,
      isGuest: guest,
      micMuted: micOff,
      camOff: !camera,
      speaking: participant.isSpeaking,
    })
    if (screen) {
      tiles.push({
        key: `${participant.identity}#screen`,
        identity: participant.identity,
        label: name,
        stream: stableStream(`${participant.identity}#screen`, screen),
        isLocal: false,
        isScreen: true,
        isGuest: guest,
        micMuted: true,
        camOff: false,
        speaking: false,
      })
    }
    participantRows.push({
      identity: participant.identity,
      label: name,
      isLocal: false,
      isGuest: guest,
      micMuted: micOff,
      camOff: !camera,
      screenSharing: !!screen,
      speaking: participant.isSpeaking,
      quality: qualityWord(lk, participant.connectionQuality),
    })
  }

  // Own tiles last, so the strip reads "them, then me".
  tiles.push({
    key: 'local',
    identity: LOCAL_KEY,
    label: selfName,
    stream: stableStream('local', camOn ? camTrackRef.current : null),
    isLocal: true,
    isScreen: false,
    isGuest: selfIsGuest,
    micMuted: !micEnabled,
    camOff: !camOn,
    speaking: room?.localParticipant.isSpeaking ?? false,
  })
  if (screenOn) {
    tiles.push({
      key: 'local#screen',
      identity: LOCAL_KEY,
      label: selfName,
      stream: stableStream('local#screen', screenTrackRef.current),
      isLocal: true,
      isScreen: true,
      isGuest: selfIsGuest,
      micMuted: true,
      camOff: false,
      speaking: false,
    })
  }

  // Drop cached streams for people who have left. Without this the map is a
  // slow leak across a long meeting — every joiner who ever shared a screen
  // keeps a MediaStream alive for as long as the tab is open.
  {
    const live = new Set(tiles.map((tile) => tile.key))
    for (const key of Array.from(streamsRef.current.keys())) {
      if (!live.has(key)) streamsRef.current.delete(key)
    }
  }

  participantRows.push({
    identity: LOCAL_KEY,
    label: selfName,
    isLocal: true,
    isGuest: selfIsGuest,
    micMuted: !micEnabled,
    camOff: !camOn,
    screenSharing: screenOn,
    speaking: room?.localParticipant.isSpeaking ?? false,
    quality: qualityWord(lk, room?.localParticipant.connectionQuality),
  })

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

  const spotlightKey = pinnedKey ?? autoSpotlightKey(tiles)
  const spotlightTile = tiles.find((tile) => tile.key === spotlightKey) ?? tiles[0]
  const stripTiles = tiles.filter((tile) => tile.key !== spotlightTile?.key)
  const alone = tiles.every((tile) => tile.isLocal)

  const renderTile = (tile: StageTile, fillHeight: boolean) => (
    <CallTile
      key={tile.key}
      peerId={tile.key}
      stream={tile.stream}
      label={tile.label}
      isLocal={tile.isLocal}
      micMuted={tile.micMuted}
      camOff={tile.camOff}
      screenSharing={tile.isScreen}
      isGuest={tile.isGuest}
      // The SFU already tells us who is talking, on the same socket the media
      // arrives on. Letting each tile build its own AnalyserNode and 100ms
      // timer to rediscover it is pure duplicated work in a ten-person room.
      externalSpeaking={tile.speaking}
      pinned={pinnedKey === tile.key}
      onPinToggle={() => setPinnedKey((prev) => (prev === tile.key ? null : tile.key))}
      fillHeight={fillHeight}
      mediaRev={localMediaRev}
    />
  )

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
          <button
            type="button"
            onClick={() => setLayout((v) => (v === 'grid' ? 'spotlight' : 'grid'))}
            className="rounded-md border border-border-strong px-2 py-1 text-[11px] text-text-muted transition hover:text-text-primary"
            title={layout === 'grid' ? t('meet.layoutSpotlight') : t('meet.layoutGrid')}
          >
            {layout === 'grid' ? t('meet.layoutSpotlight') : t('meet.layoutGrid')}
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            aria-pressed={panelOpen}
            className={`rounded-md border px-2 py-1 text-[11px] transition ${
              panelOpen
                ? 'border-neon-cyan/60 text-neon-cyan'
                : 'border-border-strong text-text-muted hover:text-text-primary'
            }`}
            title={t('meet.participantsPanel')}
          >
            {t('meet.participants').replace('{n}', String(participantRows.length))}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
          {alone ? (
            <p className="pb-2 text-center text-sm text-text-muted">{t('meet.aloneHere')}</p>
          ) : null}
          {layout === 'spotlight' && spotlightTile ? (
            <div className="flex h-full min-h-[16rem] flex-col gap-3">
              <div className="min-h-0 flex-1">{renderTile(spotlightTile, true)}</div>
              {stripTiles.length > 0 ? (
                <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
                  {stripTiles.map((tile) => (
                    <div key={tile.key} className="h-24 w-40 flex-shrink-0 md:h-28 md:w-48">
                      {renderTile(tile, true)}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
              {/* fillHeight=false — the cells here have no resolved height of
                  their own (the grid is auto-rows inside a scrolling main), so
                  a tile asking for h-full would resolve to zero and render
                  nothing at all. It takes a 16:9 box instead. */}
              {tiles.map((tile) => (
                <div key={tile.key}>{renderTile(tile, false)}</div>
              ))}
            </div>
          )}
        </main>

        {panelOpen ? (
          <aside className="w-[300px] max-w-[85vw] shrink-0">
            <MeetParticipantsPanel
              rows={participantRows}
              volumes={peerVolumes}
              muted={peerMuted}
              onVolume={(identity, value) =>
                setPeerVolumes((prev) => ({ ...prev, [identity]: value }))
              }
              onToggleMuted={(identity) =>
                setPeerMuted((prev) => ({ ...prev, [identity]: !prev[identity] }))
              }
              onKick={
                onKickGuest
                  ? (identity, name) => {
                      if (kicking !== identity) void kickGuest(identity, name)
                    }
                  : undefined
              }
              onClose={() => setPanelOpen(false)}
            />
          </aside>
        ) : null}
      </div>

      {/* Hidden audio sinks — one per remote audio publication. They live
          outside the tiles on purpose: a tile can be unmounted by a layout
          change (the spotlight strip renders a subset), and losing a tile must
          never silence the person it belonged to. */}
      {audioSinks.map((sink) => (
        <AudioSink
          key={sink.sid}
          track={sink.track}
          volume={peerMuted[sink.identity] ? 0 : (peerVolumes[sink.identity] ?? 1)}
        />
      ))}

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
          onClick={() => void toggleScreen()}
          disabled={screenBusy}
          title={screenOn ? t('meet.screenOff') : t('meet.screenOn')}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition disabled:opacity-50 ${
            screenOn
              ? 'bg-neon-cyan/20 text-neon-cyan hover:bg-neon-cyan/30'
              : 'bg-surface-elevated text-text-primary hover:bg-neon-cyan/10'
          }`}
        >
          <ScreenIcon off={!screenOn} />
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
