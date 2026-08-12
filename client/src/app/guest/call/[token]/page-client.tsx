'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * "Bodiless" guest call entry: resolve the one-time link → knock with a
 * nickname → wait for the host's approval → join the LiveKit room directly
 * with the returned URL + token. ZERO session: no cookies, no stores, no
 * authed API — only the public /guest/* endpoints.
 *
 * LiveKit handling mirrors lib/livekit-call-manager.ts:
 *   - dynamic import('livekit-client') keeps the SDK out of the main bundle
 *   - E2EE via ExternalE2EEKeyProvider + new Worker('/livekit-e2ee-worker.js')
 *   - FAIL-CLOSED: when the server issued call_e2ee_key, any provider/worker
 *     failure aborts the join instead of connecting plaintext-to-SFU
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  resolveGuestToken,
  guestKnock,
  pollGuestKnock,
  cancelGuestKnock,
  type GuestKnockCreated,
  type GuestKnockStatus,
} from '@/lib/api/guest'
import type {
  Room,
  RoomOptions,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  LocalAudioTrack,
  LocalVideoTrack,
} from 'livekit-client'

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

/** Participant metadata JSON {"guest":true} marks link-invited guests. */
function isGuestMeta(meta: string | undefined): boolean {
  if (!meta) return false
  try {
    return (JSON.parse(meta) as { guest?: boolean }).guest === true
  } catch {
    return false
  }
}

function displayName(p: RemoteParticipant): string {
  return p.name && p.name.length > 0 ? p.name : p.identity
}

// ─── Stages ─────────────────────────────────────────────────────────────────

type Stage =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'calls-unavailable' }
  | { kind: 'form' }
  | { kind: 'waiting' }
  | { kind: 'no-answer' }
  | { kind: 'denied' }
  | { kind: 'connecting' }
  | { kind: 'in-call' }
  | { kind: 'ended'; left: boolean }
  | { kind: 'error'; message: string }

// ─── Small UI atoms ─────────────────────────────────────────────────────────

function CenterCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-950 px-4 text-neutral-100">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        {children}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div
      className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-100"
      aria-label="Загрузка"
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

function ParticipantTile({ participant }: { participant: RemoteParticipant }) {
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
  const guest = isGuestMeta(participant.metadata)
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
            гость
          </span>
        ) : null}
        {micOff ? (
          <span className="text-neutral-400">
            <MicIcon off />
          </span>
        ) : null}
      </div>
    </div>
  )
}

// ─── Page client ────────────────────────────────────────────────────────────

export function GuestCallClient({ routeToken }: { routeToken: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Static export ships only /guest/call/_ — accept ?token= there (join/[code]
  // pattern).
  const token =
    routeToken && routeToken !== '_'
      ? routeToken
      : (searchParams.get('token') ?? '')

  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [hostName, setHostName] = useState('')
  const [nickname, setNickname] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // In-call state
  const [micEnabled, setMicEnabled] = useState(false)
  const [camOn, setCamOn] = useState(false)
  const [camBusy, setCamBusy] = useState(false)
  const [e2eeActive, setE2eeActive] = useState(false)
  // Bumped on every relevant RoomEvent so the tile grid re-renders.
  const [, setRoomVersion] = useState(0)

  const knockRef = useRef<GuestKnockCreated | null>(null)
  const pollGenRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const roomRef = useRef<Room | null>(null)
  const micTrackRef = useRef<LocalAudioTrack | null>(null)
  const camTrackRef = useRef<LocalVideoTrack | null>(null)
  const leavingRef = useRef(false)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)

  const stopPolling = useCallback(() => {
    pollGenRef.current++
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const cleanupLocalTracks = useCallback(() => {
    micTrackRef.current?.stop()
    micTrackRef.current = null
    camTrackRef.current?.stop()
    camTrackRef.current = null
    setCamOn(false)
  }, [])

  // ── Step 1: resolve the token ─────────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setStage({ kind: 'invalid' })
      return
    }
    let alive = true
    void (async () => {
      try {
        const info = await resolveGuestToken(token)
        if (!alive) return
        if (info.kind !== 'call') {
          router.replace(`/guest/chat/${encodeURIComponent(token)}`)
          return
        }
        if (!info.can_join) {
          setStage({ kind: 'calls-unavailable' })
          return
        }
        setHostName(info.host_name)
        setStage({ kind: 'form' })
      } catch {
        if (alive) setStage({ kind: 'invalid' })
      }
    })()
    return () => {
      alive = false
    }
  }, [token, router])

  // ── Unmount: cancel a pending knock, drop the room ────────────────────────
  useEffect(() => {
    return () => {
      stopPolling()
      const k = knockRef.current
      knockRef.current = null
      if (k) void cancelGuestKnock(k.knock_id, k.knock_secret)
      micTrackRef.current?.stop()
      micTrackRef.current = null
      camTrackRef.current?.stop()
      camTrackRef.current = null
      const room = roomRef.current
      roomRef.current = null
      if (room) void room.disconnect()
    }
  }, [stopPolling])

  // ── Step 4: approved → join the LiveKit room ──────────────────────────────
  const joinRoom = useCallback(
    async (approved: Extract<GuestKnockStatus, { status: 'approved' }>) => {
      stopPolling()
      knockRef.current = null // one-time: nothing to cancel past this point
      setStage({ kind: 'connecting' })

      let lk: LkModule
      try {
        lk = await loadLk()
      } catch {
        setStage({
          kind: 'error',
          message: 'Не удалось загрузить модуль звонков. Обновите страницу.',
        })
        return
      }

      const options: RoomOptions = {
        adaptiveStream: true,
        dynacast: true,
      }

      // FAIL-CLOSED: the server issued a room key ⇒ frame encryption is
      // mandatory. If the provider or the worker cannot be set up, abort with
      // an error screen — never connect plaintext-to-SFU.
      if (approved.call_e2ee_key) {
        try {
          const keyBytes = b64ToBytes(approved.call_e2ee_key)
          const provider = new lk.ExternalE2EEKeyProvider()
          await provider.setKey(keyBytes.buffer as ArrayBuffer)
          const worker = new Worker('/livekit-e2ee-worker.js')
          options.e2ee = { keyProvider: provider, worker }
        } catch {
          setStage({
            kind: 'error',
            message:
              'Не удалось настроить шифрование звонка. Подключение без шифрования запрещено — попробуйте другой браузер.',
          })
          return
        }
      }

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
          setStage({ kind: 'ended', left: leavingRef.current })
        })

      try {
        await room.connect(approved.livekit_url, approved.token)
      } catch {
        roomRef.current = null
        try {
          await room.disconnect()
        } catch {
          /* never connected */
        }
        setStage({
          kind: 'error',
          message:
            'Не удалось подключиться к встрече. Обновите страницу и попробуйте снова.',
        })
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
        // No mic permission — the guest can still listen; the mic button
        // retries via setMicrophoneEnabled(true).
        setMicEnabled(false)
      }

      setStage({ kind: 'in-call' })
      bump()
    },
    [stopPolling]
  )

  // ── Step 3: poll the knock until approved / denied / timed out ────────────
  const startPolling = useCallback(
    (k: GuestKnockCreated) => {
      stopPolling()
      const gen = pollGenRef.current
      const intervalMs = Math.max(1, k.poll_interval_s || 2) * 1000
      const deadline = Date.now() + Math.max(intervalMs, (k.ttl_s || 60) * 1000)

      const schedule = () => {
        pollTimerRef.current = setTimeout(() => void tick(), intervalMs)
      }
      const tick = async () => {
        if (pollGenRef.current !== gen) return
        if (Date.now() > deadline) {
          setStage({ kind: 'no-answer' })
          return
        }
        let status: GuestKnockStatus
        try {
          status = await pollGuestKnock(k.knock_id, k.knock_secret)
        } catch {
          // Transient network hiccup or already-purged knock — keep polling
          // until the ttl deadline, then declare "no answer".
          if (pollGenRef.current === gen) schedule()
          return
        }
        if (pollGenRef.current !== gen) return
        if (status.status === 'pending') {
          schedule()
          return
        }
        if (status.status === 'denied') {
          knockRef.current = null
          setStage({ kind: 'denied' })
          return
        }
        void joinRoom(status)
      }
      schedule()
    },
    [stopPolling, joinRoom]
  )

  // ── Step 2: knock with a nickname ─────────────────────────────────────────
  const submitKnock = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      const name = nickname.trim()
      if (name.length < 1 || name.length > 32) {
        setFormError('Имя должно быть от 1 до 32 символов')
        return
      }
      setBusy(true)
      setFormError(null)
      try {
        const k = await guestKnock(token, name)
        knockRef.current = k
        setStage({ kind: 'waiting' })
        startPolling(k)
      } catch (err) {
        const code = err instanceof Error ? err.message : ''
        switch (code) {
          case 'NICKNAME_TAKEN':
            setFormError('Это имя занято — выберите другое')
            break
          case 'INVALID_NICKNAME':
            setFormError('Недопустимое имя — используйте от 1 до 32 символов')
            break
          case 'KNOCK_PENDING':
            setFormError('Запрос уже отправлен — подождите немного')
            break
          case 'CALLS_NOT_AVAILABLE':
            setStage({ kind: 'calls-unavailable' })
            break
          case 'INVITE_NOT_FOUND':
            setStage({ kind: 'invalid' })
            break
          default:
            setFormError('Не удалось отправить запрос — попробуйте ещё раз')
        }
      } finally {
        setBusy(false)
      }
    },
    [nickname, token, startPolling]
  )

  const cancelWaiting = useCallback(() => {
    stopPolling()
    const k = knockRef.current
    knockRef.current = null
    if (k) void cancelGuestKnock(k.knock_id, k.knock_secret)
    setFormError(null)
    setStage({ kind: 'form' })
  }, [stopPolling])

  // ── In-call controls ──────────────────────────────────────────────────────
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
    cleanupLocalTracks()
    const room = roomRef.current
    roomRef.current = null
    if (room) {
      try {
        await room.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    setStage({ kind: 'ended', left: true })
  }, [cleanupLocalTracks])

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

  // ── Screens ───────────────────────────────────────────────────────────────

  if (stage.kind === 'loading' || stage.kind === 'connecting') {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-4">
          <Spinner />
          <p className="text-sm text-neutral-400">
            {stage.kind === 'loading'
              ? 'Проверяем приглашение…'
              : 'Подключаемся к встрече…'}
          </p>
        </div>
      </CenterCard>
    )
  }

  if (stage.kind === 'invalid') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">
          Ссылка недействительна или истекла
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Попросите пригласившего вас человека прислать новую ссылку.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'calls-unavailable') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">
          Звонки на этом сервере недоступны
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Присоединиться к встрече по этой ссылке сейчас нельзя.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'form') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Встреча у {hostName}</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Представьтесь, чтобы постучаться в комнату.
        </p>
        <form onSubmit={(e) => void submitKnock(e)} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm text-neutral-300">
              Ваше имя
            </span>
            <input
              type="text"
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value)
                setFormError(null)
              }}
              maxLength={32}
              autoFocus
              placeholder="Например, Аня"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </label>
          {formError ? (
            <p className="text-sm text-red-400" role="alert">
              {formError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || nickname.trim().length === 0}
            className="w-full rounded-lg bg-neutral-100 px-4 py-2 font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Отправляем…' : 'Постучаться'}
          </button>
        </form>
      </CenterCard>
    )
  }

  if (stage.kind === 'waiting') {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <Spinner />
          <p className="text-sm text-neutral-300">
            Ждём, пока {hostName} вас впустит…
          </p>
          <button
            type="button"
            onClick={cancelWaiting}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition hover:bg-neutral-800"
          >
            Отменить
          </button>
        </div>
      </CenterCard>
    )
  }

  if (stage.kind === 'no-answer') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Никто не ответил</h1>
        <p className="mt-2 text-sm text-neutral-400">
          {hostName} не отреагировал(а) на ваш запрос вовремя.
        </p>
        <button
          type="button"
          onClick={() => {
            setFormError(null)
            setStage({ kind: 'form' })
          }}
          className="mt-4 w-full rounded-lg bg-neutral-100 px-4 py-2 font-medium text-neutral-900 transition hover:bg-white"
        >
          Попробовать ещё раз
        </button>
      </CenterCard>
    )
  }

  if (stage.kind === 'denied') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Вам отказали во входе</h1>
        <p className="mt-2 text-sm text-neutral-400">
          {hostName} не впустил(а) вас в эту встречу.
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'ended') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">
          {stage.left
            ? 'Встреча завершена'
            : 'Вы покинули встречу или были отключены'}
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          {stage.left
            ? 'Можете закрыть вкладку.'
            : 'Если это произошло по ошибке — попросите новую ссылку.'}
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'error') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">Не получилось подключиться</h1>
        <p className="mt-2 text-sm text-neutral-400">{stage.message}</p>
      </CenterCard>
    )
  }

  // ── In-call ───────────────────────────────────────────────────────────────
  const room = roomRef.current
  const remotes: RemoteParticipant[] = room
    ? Array.from(room.remoteParticipants.values())
    : []
  const participantCount = remotes.length + 1

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <h1 className="truncate text-sm font-semibold">
          Встреча у {hostName}
        </h1>
        <div className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
          {e2eeActive ? (
            <span
              className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300"
              title="Медиапотоки шифруются"
            >
              шифрование
            </span>
          ) : null}
          <span>Участников: {participantCount}</span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-3">
        {remotes.length === 0 ? (
          <div className="flex h-full min-h-[10rem] items-center justify-center text-sm text-neutral-500">
            Пока здесь больше никого нет
          </div>
        ) : null}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          {remotes.map((p) => (
            <ParticipantTile key={p.identity} participant={p} />
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
                Я
              </div>
            )}
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-neutral-950/70 px-2 py-1 text-xs">
              <span>Вы</span>
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                гость
              </span>
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
          title={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
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
          title={camOn ? 'Выключить камеру' : 'Включить камеру'}
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
          <span className="text-sm">Покинуть встречу</span>
        </button>
      </footer>
    </div>
  )
}
