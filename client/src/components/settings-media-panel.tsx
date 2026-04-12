'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { applyPreferredAudioOutput, loadMediaPrefs, saveMediaPrefs } from '@/lib/media-devices'
import {
  clearAllMediaCache,
  getDigitalDenUsageBytes,
} from '@/lib/media-cache'
import { useTranslation } from '@/hooks/use-translation'

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / (1024 * 1024)).toFixed(2)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

export function SettingsMediaPanel({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [speakerId, setSpeakerId] = useState('')
  const [noiseOn, setNoiseOn] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [denBytes, setDenBytes] = useState<number | null>(null)
  const [denBusy, setDenBusy] = useState(false)
  const [denNote, setDenNote] = useState<string | null>(null)

  const refreshDeviceList = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const md = navigator.mediaDevices
    if (!md?.addEventListener) return
    const onChange = () => void refreshDeviceList()
    md.addEventListener('devicechange', onChange)
    return () => md.removeEventListener('devicechange', onChange)
  }, [active, refreshDeviceList])

  useEffect(() => {
    const p = loadMediaPrefs()
    setCameraId(p.cameraId ?? '')
    setMicId(p.micId ?? '')
    setSpeakerId(p.speakerId ?? '')
    setNoiseOn(p.noiseSuppression)
  }, [active])

  const refreshDen = useCallback(async () => {
    try {
      const n = await getDigitalDenUsageBytes()
      setDenBytes(n)
    } catch {
      setDenBytes(null)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void refreshDen()
    const id = window.setInterval(() => void refreshDen(), 8000)
    return () => window.clearInterval(id)
  }, [active, refreshDen])

  const startPreview = useCallback(async () => {
    stopTracks(streamRef.current)
    streamRef.current = null
    setPreviewError(null)

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPreviewError(t('settings.mediaNoApi'))
      return
    }

    const prefs = loadMediaPrefs()
    const audio: MediaTrackConstraints = {
      echoCancellation: prefs.noiseSuppression,
      noiseSuppression: prefs.noiseSuppression,
    }
    if (prefs.micId) {
      audio.deviceId = { exact: prefs.micId }
    }
    const video: boolean | MediaTrackConstraints = prefs.cameraId
      ? { deviceId: { exact: prefs.cameraId } }
      : true

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video })
      streamRef.current = stream
      const el = videoRef.current
      if (el) {
        el.srcObject = stream
        await applyPreferredAudioOutput(el)
      }
      await refreshDeviceList()
    } catch (e) {
      const err = e as { name?: string }
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        setPreviewError(t('settings.mediaDenied'))
      } else {
        setPreviewError(t('settings.mediaPreviewFailed'))
      }
    }
  }, [refreshDeviceList, t])

  useEffect(() => {
    if (!active) {
      stopTracks(streamRef.current)
      streamRef.current = null
      const el = videoRef.current
      if (el) el.srcObject = null
      return
    }
    void refreshDeviceList()
    void startPreview()
    return () => {
      stopTracks(streamRef.current)
      streamRef.current = null
      const el = videoRef.current
      if (el) el.srcObject = null
    }
  }, [active, refreshDeviceList, startPreview])

  useEffect(() => {
    if (!active) return
    const el = videoRef.current
    if (!el || !speakerId) return
    void applyPreferredAudioOutput(el)
  }, [active, speakerId])

  const cams = devices.filter((d) => d.kind === 'videoinput')
  const mics = devices.filter((d) => d.kind === 'audioinput')
  const outs = devices.filter((d) => d.kind === 'audiooutput')

  function labelFor(d: MediaDeviceInfo) {
    if (d.label) return d.label
    return `${d.kind.replace('input', '').replace('output', '')} ${d.deviceId.slice(0, 8)}…`
  }

  return (
    <div className="space-y-4 border-t border-neon-cyan/30 pt-3">
      <div>
        <p className="text-xs uppercase tracking-[0.25em] text-neon-cyan">
          {t('settings.mediaSectionTitle')}
        </p>
        <p className="mt-1 text-[9px] text-red-800">{t('settings.mediaHint')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-1">
        <label className="block space-y-1">
          <span className="terminal-label">{t('settings.mediaCamera')}</span>
          <select
            className="terminal-input w-full py-2 text-xs"
            value={cameraId}
            onChange={(e) => {
              const v = e.target.value
              setCameraId(v)
              saveMediaPrefs({ cameraId: v || null })
              void startPreview()
            }}
          >
            <option value="">{t('settings.mediaDefault')}</option>
            {cams.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {labelFor(d)}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="terminal-label">{t('settings.mediaMic')}</span>
          <select
            className="terminal-input w-full py-2 text-xs"
            value={micId}
            onChange={(e) => {
              const v = e.target.value
              setMicId(v)
              saveMediaPrefs({ micId: v || null })
              void startPreview()
            }}
          >
            <option value="">{t('settings.mediaDefault')}</option>
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {labelFor(d)}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="terminal-label">{t('settings.mediaSpeaker')}</span>
          <select
            className="terminal-input w-full py-2 text-xs"
            value={speakerId}
            onChange={(e) => {
              const v = e.target.value
              setSpeakerId(v)
              saveMediaPrefs({ speakerId: v || null })
              const el = videoRef.current
              if (el) void applyPreferredAudioOutput(el)
            }}
          >
            <option value="">{t('settings.mediaDefault')}</option>
            {outs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {labelFor(d)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between gap-3 border border-neon-cyan/20 px-2 py-2">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-neon-cyan">
            {t('settings.mediaNoise')}
          </p>
          <p className="text-[9px] text-zinc-500">{t('settings.mediaNoiseHint')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={noiseOn}
          onClick={() => {
            const next = !noiseOn
            setNoiseOn(next)
            saveMediaPrefs({ noiseSuppression: next })
            void startPreview()
          }}
          className={`shrink-0 border-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${
            noiseOn
              ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
              : 'border-zinc-600 bg-zinc-950 text-zinc-400'
          }`}
        >
          {noiseOn ? '[ ON ]' : '[ OFF ]'}
        </button>
      </div>

      <div>
        <p className="mb-1 text-[9px] uppercase tracking-wider text-zinc-500">
          {t('settings.mediaViewfinder')}
        </p>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          className="mt-1 h-48 w-full border border-neon-cyan/30 bg-black object-cover"
        />
        {previewError ? (
          <p className="mt-2 break-words border border-neon-red/60 px-2 py-1 font-mono text-[10px] text-neon-red">
            [!] {previewError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2 border border-neon-cyan/25 bg-black/60 px-3 py-3">
        <p className="text-[10px] uppercase tracking-[0.35em] text-neon-cyan">
          {t('settings.digitalDenTitle')}
        </p>
        <p className="text-[9px] leading-snug text-red-800/90">
          {t('settings.digitalDenHint')}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 border border-neon-cyan/15 px-2 py-2 font-mono text-[10px] text-neon-cyan/90">
          <p className="break-words">
            :: {t('settings.digitalDenUsage')}:{' '}
            {denBytes === null ? '—' : formatBytes(denBytes)}
          </p>
          <button
            type="button"
            disabled={denBusy}
            onClick={() => {
              setDenBusy(true)
              setDenNote(null)
              void (async () => {
                try {
                  await clearAllMediaCache()
                  await refreshDen()
                  setDenNote(t('settings.digitalDenCleared'))
                  window.setTimeout(() => setDenNote(null), 2500)
                } catch {
                  setDenNote('ERR')
                } finally {
                  setDenBusy(false)
                }
              })()
            }}
            className="border border-neon-red/70 bg-black px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40"
          >
            [ {denBusy ? t('settings.digitalDenBusy') : t('settings.digitalDenClear')} ]
          </button>
        </div>
        {denNote ? (
          <p className="break-words font-mono text-[9px] text-neon-cyan/90">
            :: {denNote}
          </p>
        ) : null}
      </div>
    </div>
  )
}
