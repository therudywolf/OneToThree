'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import imageCompression from 'browser-image-compression'
import {
  applyPreferredAudioOutput,
  loadMediaPrefs,
  saveMediaPrefs,
  loadCamEffectImage,
  saveCamEffectImage,
  type CameraEffectPref,
  type ScreenShareContent,
  type ScreenShareFps,
  type ScreenShareRes,
} from '@/lib/media-devices'
import {
  applyVoiceSettingsToActiveCalls,
  createProcessedMicTrack,
  type VoiceProcessingHandle,
} from '@/lib/voice-processing'
import {
  applyCameraEffectToActiveCalls,
  createEffectedCameraTrack,
  type CameraEffectsHandle,
} from '@/lib/camera-effects'
import {
  clearAllMediaCache,
  getDigitalDenUsageBytes,
} from '@/lib/media-cache'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

/**
 * Live mic level meter with a draggable gate-threshold marker — the Discord
 * "input sensitivity" picture. Reads the settings-preview stream.
 */
function MicLevelMeter({
  stream,
  thresholdDb,
  gateOn,
}: {
  stream: MediaStream | null
  thresholdDb: number
  gateOn: boolean
}) {
  const [levelDb, setLevelDb] = useState(-90)
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevelDb(-90)
      return
    }
    let ctx: AudioContext
    try {
      ctx = new AudioContext()
    } catch {
      return
    }
    let source: MediaStreamAudioSourceNode
    try {
      source = ctx.createMediaStreamSource(stream)
    } catch {
      void ctx.close().catch(() => {})
      return
    }
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    const id = window.setInterval(() => {
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!
      const rms = Math.sqrt(sum / data.length)
      setLevelDb(20 * Math.log10(rms + 1e-10))
    }, 66)
    return () => {
      window.clearInterval(id)
      try { source.disconnect() } catch { /* detached */ }
      void ctx.close().catch(() => {})
    }
  }, [stream])

  // Map -90..0 dB → 0..100%.
  const pct = Math.min(100, Math.max(0, ((levelDb + 90) / 90) * 100))
  const thrPct = Math.min(100, Math.max(0, ((thresholdDb + 90) / 90) * 100))
  const open = !gateOn || levelDb >= thresholdDb

  return (
    <div className="relative h-3 w-full overflow-hidden border border-border-strong bg-void">
      <div
        className={`h-full transition-[width] duration-75 ${open ? 'bg-neon-cyan/70' : 'bg-text-muted/40'}`}
        style={{ width: `${pct}%` }}
      />
      {gateOn ? (
        <div
          className="absolute inset-y-0 w-0.5 bg-neon-red"
          style={{ left: `${thrPct}%` }}
          aria-hidden
        />
      ) : null}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / (1024 * 1024)).toFixed(2)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

export function SettingsMediaPanel({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode === 'md3')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [speakerId, setSpeakerId] = useState('')
  const [lowBandwidth, setLowBandwidth] = useState(false)
  const [echoCancel, setEchoCancel] = useState(true)
  const [noiseSuppress, setNoiseSuppress] = useState(true)
  const [autoGain, setAutoGain] = useState(true)
  const [noiseGate, setNoiseGate] = useState(false)
  const [noiseGateDb, setNoiseGateDb] = useState(-55)
  const [screenAudio, setScreenAudio] = useState(true)
  const [screenRes, setScreenRes] = useState<ScreenShareRes>('1080p')
  const [screenFps, setScreenFps] = useState<ScreenShareFps>('30')
  const [screenContent, setScreenContent] = useState<ScreenShareContent>('auto')
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [camEffect, setCamEffect] = useState<CameraEffectPref>('none')
  const [camImage, setCamImage] = useState<string | null>(null)
  const [camImageBusy, setCamImageBusy] = useState(false)
  /** Effects chain for the settings viewfinder — previews blur/image live. */
  const previewFxRef = useRef<CameraEffectsHandle | null>(null)
  /** Mic loopback ("hear yourself"): processed chain + its playback element. */
  const [loopbackOn, setLoopbackOn] = useState(false)
  const loopbackAudioRef = useRef<HTMLAudioElement | null>(null)
  const loopbackFxRef = useRef<VoiceProcessingHandle | null>(null)

  const stopLoopback = useCallback(() => {
    // keepRawTrack: the raw mic belongs to the settings PREVIEW stream and
    // must keep feeding the meter after the loopback toggle goes off.
    loopbackFxRef.current?.dispose({ keepRawTrack: true })
    loopbackFxRef.current = null
    const el = loopbackAudioRef.current
    if (el) {
      el.srcObject = null
      el.pause()
    }
    setLoopbackOn(false)
  }, [])

  const startLoopback = useCallback(async () => {
    const raw = streamRef.current?.getAudioTracks()[0]
    const el = loopbackAudioRef.current
    if (!raw || !el) return
    // Route through the SAME processing chain calls use (noise gate included)
    // so the user hears exactly what peers would hear.
    let playStream: MediaStream | null = null
    try {
      const fx = await createProcessedMicTrack(raw)
      if (fx) {
        loopbackFxRef.current = fx
        playStream = new MediaStream([fx.processedTrack])
      }
    } catch { /* fall back to the raw mic below */ }
    el.srcObject = playStream ?? new MediaStream([raw])
    el.muted = false
    el.volume = 1
    void el.play().catch(() => {})
    void applyPreferredAudioOutput(el)
    setLoopbackOn(true)
  }, [])
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
    setLowBandwidth(p.lowBandwidth)
    setEchoCancel(p.echoCancel)
    setNoiseSuppress(p.noiseSuppress)
    setAutoGain(p.autoGain)
    setNoiseGate(p.noiseGate)
    setNoiseGateDb(p.noiseGateDb)
    setScreenAudio(p.screenAudio)
    setScreenRes(p.screenRes)
    setScreenFps(p.screenFps)
    setScreenContent(p.screenContent)
    setCamEffect(p.camEffect)
    setCamImage(loadCamEffectImage())
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
    previewFxRef.current?.dispose()
    previewFxRef.current = null
    stopTracks(streamRef.current)
    streamRef.current = null
    setPreviewError(null)

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPreviewError(t('settings.mediaNoApi'))
      return
    }

    const prefs = loadMediaPrefs()
    const audio: MediaTrackConstraints = {
      echoCancellation: prefs.echoCancel,
      noiseSuppression: prefs.noiseSuppress,
      autoGainControl: prefs.autoGain,
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
      setPreviewStream(stream)
      // Viewfinder previews the background effect for real: wrap the raw
      // camera through the same chain calls use.
      let displayStream = stream
      if (prefs.camEffect !== 'none') {
        const rawVideo = stream.getVideoTracks()[0]
        if (rawVideo) {
          try {
            const fx = await createEffectedCameraTrack(rawVideo, {
              kind: prefs.camEffect,
              imageDataUrl: loadCamEffectImage(),
            })
            if (fx) {
              previewFxRef.current = fx
              displayStream = new MediaStream([fx.processedTrack, ...stream.getAudioTracks()])
            }
          } catch { /* effects unavailable — raw preview */ }
        }
      }
      const el = videoRef.current
      if (el) {
        el.srcObject = displayStream
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
      stopLoopback()
      previewFxRef.current?.dispose()
      previewFxRef.current = null
      stopTracks(streamRef.current)
      streamRef.current = null
      setPreviewStream(null)
      const el = videoRef.current
      if (el) el.srcObject = null
      return
    }
    void refreshDeviceList()
    void startPreview()
    return () => {
      stopLoopback()
      previewFxRef.current?.dispose()
      previewFxRef.current = null
      stopTracks(streamRef.current)
      streamRef.current = null
      setPreviewStream(null)
      const el = videoRef.current
      if (el) el.srcObject = null
    }
  }, [active, refreshDeviceList, startPreview, stopLoopback])

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
    <div className={`space-y-4 border-t pt-3 ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : 'border-neon-cyan/30'}`}>
      <div>
        <p className="text-xs uppercase tracking-[0.25em] text-neon-cyan">
          {t('settings.mediaSectionTitle')}
        </p>
        <p className="mt-1 text-[9px] text-danger">{t('settings.mediaHint')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-1">
        <label className="block space-y-1">
          <span className="terminal-label">{t('settings.mediaCamera')}</span>
          <select
            className={`w-full py-2 text-xs ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] px-4' : 'terminal-input'}`}
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
            className={`w-full py-2 text-xs ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] px-4' : 'terminal-input'}`}
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
            className={`w-full py-2 text-xs ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] px-4' : 'terminal-input'}`}
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

      {/* VOICE PROCESSING — granular Discord-style switches. Changes apply to
          the settings preview immediately and are pushed into any ACTIVE call
          (applyVoiceSettingsToActiveCalls). */}
      <div className={`space-y-2 px-2 py-2 ${isMd3 ? 'rounded-[20px] bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]' : 'border border-neon-cyan/20'}`}>
        <p className="text-[10px] uppercase tracking-widest text-neon-cyan">
          {t('settings.voiceSectionTitle')}
        </p>
        {([
          { key: 'echo', label: t('settings.voiceEcho'), hint: t('settings.voiceEchoHint'), value: echoCancel, set: (v: boolean) => { setEchoCancel(v); saveMediaPrefs({ echoCancel: v }) } },
          { key: 'noise', label: t('settings.voiceNoise'), hint: t('settings.voiceNoiseHint'), value: noiseSuppress, set: (v: boolean) => { setNoiseSuppress(v); saveMediaPrefs({ noiseSuppress: v }) } },
          { key: 'agc', label: t('settings.voiceAgc'), hint: t('settings.voiceAgcHint'), value: autoGain, set: (v: boolean) => { setAutoGain(v); saveMediaPrefs({ autoGain: v }) } },
        ] as const).map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-text-primary">{row.label}</p>
              <p className="text-[9px] text-text-muted">{row.hint}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={row.value}
              onClick={() => {
                row.set(!row.value)
                void applyVoiceSettingsToActiveCalls()
                void startPreview()
              }}
              className={`shrink-0 px-3 py-1.5 text-[10px] ${
                row.value
                  ? (isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]' : 'border-2 border-neon-cyan bg-neon-cyan/10 font-mono uppercase tracking-widest text-neon-cyan')
                  : (isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-text-muted' : 'border-2 border-border-strong/60 bg-void font-mono uppercase tracking-widest text-text-muted')
              }`}
            >
              {row.value ? '[ ON ]' : '[ OFF ]'}
            </button>
          </div>
        ))}

        {/* Noise gate + threshold + live meter */}
        <div className="flex items-center justify-between gap-3 border-t border-border-strong/40 pt-2">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-text-primary">{t('settings.voiceGate')}</p>
            <p className="text-[9px] text-text-muted">{t('settings.voiceGateHint')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={noiseGate}
            onClick={() => {
              const next = !noiseGate
              setNoiseGate(next)
              saveMediaPrefs({ noiseGate: next })
              void applyVoiceSettingsToActiveCalls()
            }}
            className={`shrink-0 px-3 py-1.5 text-[10px] ${
              noiseGate
                ? (isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]' : 'border-2 border-neon-cyan bg-neon-cyan/10 font-mono uppercase tracking-widest text-neon-cyan')
                : (isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-text-muted' : 'border-2 border-border-strong/60 bg-void font-mono uppercase tracking-widest text-text-muted')
            }`}
          >
            {noiseGate ? '[ ON ]' : '[ OFF ]'}
          </button>
        </div>
        <MicLevelMeter stream={previewStream} thresholdDb={noiseGateDb} gateOn={noiseGate} />
        {/* Mic loopback — hear yourself through the real processing chain. */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[9px] text-text-muted">{t('settings.voiceLoopbackHint')}</p>
          <button
            type="button"
            onClick={() => { if (loopbackOn) stopLoopback(); else void startLoopback() }}
            className={`shrink-0 px-3 py-1.5 text-[10px] ${
              loopbackOn
                ? (isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]' : 'border-2 border-neon-cyan bg-neon-cyan/10 font-mono uppercase tracking-widest text-neon-cyan')
                : (isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-text-muted' : 'border-2 border-border-strong/60 bg-void font-mono uppercase tracking-widest text-text-muted hover:border-neon-cyan hover:text-neon-cyan')
            }`}
            aria-pressed={loopbackOn}
          >
            {loopbackOn ? t('settings.voiceLoopbackStop') : t('settings.voiceLoopbackStart')}
          </button>
        </div>
        <audio ref={loopbackAudioRef} className="hidden" playsInline />
        {noiseGate ? (
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={-90}
              max={-20}
              step={1}
              value={noiseGateDb}
              onChange={(e) => {
                const v = Number(e.target.value)
                setNoiseGateDb(v)
                saveMediaPrefs({ noiseGateDb: v })
                void applyVoiceSettingsToActiveCalls()
              }}
              className="h-1 w-full cursor-pointer accent-[var(--neon-cyan,#0ff)]"
              aria-label={t('settings.voiceGateThreshold')}
            />
            <span className="w-14 shrink-0 text-right font-mono text-[9px] text-text-muted">
              {noiseGateDb} dB
            </span>
          </div>
        ) : null}
      </div>

      {/* SCREEN SHARE OPTIONS */}
      <div className={`space-y-2 px-2 py-2 ${isMd3 ? 'rounded-[20px] bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]' : 'border border-neon-cyan/20'}`}>
        <p className="text-[10px] uppercase tracking-widest text-neon-cyan">
          {t('settings.screenSectionTitle')}
        </p>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-text-primary">{t('settings.screenAudio')}</p>
            <p className="text-[9px] text-text-muted">{t('settings.screenAudioHint')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={screenAudio}
            onClick={() => {
              const next = !screenAudio
              setScreenAudio(next)
              saveMediaPrefs({ screenAudio: next })
            }}
            className={`shrink-0 px-3 py-1.5 text-[10px] ${
              screenAudio
                ? (isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]' : 'border-2 border-neon-cyan bg-neon-cyan/10 font-mono uppercase tracking-widest text-neon-cyan')
                : (isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-text-muted' : 'border-2 border-border-strong/60 bg-void font-mono uppercase tracking-widest text-text-muted')
            }`}
          >
            {screenAudio ? '[ ON ]' : '[ OFF ]'}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="terminal-label">{t('settings.screenQuality')}</span>
            <select
              className={`w-full py-2 text-xs ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] px-4' : 'terminal-input'}`}
              value={screenRes}
              onChange={(e) => {
                const v = e.target.value as ScreenShareRes
                setScreenRes(v)
                saveMediaPrefs({ screenRes: v })
              }}
            >
              <option value="720p">720p</option>
              <option value="1080p">1080p (Full HD)</option>
              <option value="1440p">1440p (2K)</option>
              <option value="4k">2160p (4K)</option>
              <option value="source">{t('settings.screenQualitySource')}</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="terminal-label">{t('settings.screenFps')}</span>
            <select
              className={`w-full py-2 text-xs ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] px-4' : 'terminal-input'}`}
              value={screenFps}
              onChange={(e) => {
                const v = e.target.value as ScreenShareFps
                setScreenFps(v)
                saveMediaPrefs({ screenFps: v })
              }}
            >
              <option value="30">30 fps</option>
              <option value="60">60 fps</option>
              <option value="120">120 fps</option>
              <option value="source">{t('settings.screenFpsSource')}</option>
            </select>
          </label>
        </div>
        <p className="text-[9px] text-text-muted">{t('settings.screenFpsHint')}</p>
        <label className="block space-y-1">
          <span className="terminal-label">{t('settings.screenContent')}</span>
          <select
            className={`w-full py-2 text-xs ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] px-4' : 'terminal-input'}`}
            value={screenContent}
            onChange={(e) => {
              const v = e.target.value as ScreenShareContent
              setScreenContent(v)
              saveMediaPrefs({ screenContent: v })
            }}
          >
            <option value="auto">{t('settings.screenContentAuto')}</option>
            <option value="motion">{t('settings.screenContentMotion')}</option>
            <option value="detail">{t('settings.screenContentDetail')}</option>
          </select>
        </label>
      </div>

      {/* CAMERA BACKGROUND (blur / image) — applies live to calls + the
          viewfinder below. Fully local segmentation (MediaPipe, self-hosted). */}
      <div className={`space-y-2 px-2 py-2 ${isMd3 ? 'rounded-[20px] bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]' : 'border border-neon-cyan/20'}`}>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-neon-cyan">
            {t('settings.camBgSectionTitle')}
          </p>
          <p className="text-[9px] text-text-muted">{t('settings.camBgHint')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(['none', 'blur', 'image'] as const).map((kind) => {
            const label =
              kind === 'none'
                ? t('call.backgroundNone')
                : kind === 'blur'
                  ? t('call.backgroundBlur')
                  : t('call.backgroundImage')
            const activeKind = camEffect === kind
            return (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  setCamEffect(kind)
                  saveMediaPrefs({ camEffect: kind })
                  applyCameraEffectToActiveCalls(kind, loadCamEffectImage())
                  void startPreview()
                }}
                className={`px-3 py-1.5 text-[10px] ${
                  activeKind
                    ? (isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]' : 'border-2 border-neon-cyan bg-neon-cyan/10 font-mono uppercase tracking-widest text-neon-cyan')
                    : (isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-text-muted' : 'border-2 border-border-strong/60 bg-void font-mono uppercase tracking-widest text-text-muted')
                }`}
                aria-pressed={activeKind}
              >
                {label}
              </button>
            )
          })}
        </div>
        {camEffect === 'image' ? (
          <div className="flex items-center gap-3">
            {camImage ? (
              <img
                src={camImage}
                alt={t('settings.camBgImageAlt')}
                className="h-14 w-24 border border-border-strong object-cover"
              />
            ) : (
              <p className="font-mono text-[9px] uppercase tracking-wider text-text-muted">
                {t('settings.camBgNoImage')}
              </p>
            )}
            <label className={`cursor-pointer px-3 py-1.5 text-[10px] ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-text-muted' : 'border-2 border-border-strong/60 bg-void font-mono uppercase tracking-widest text-text-muted hover:border-neon-cyan hover:text-neon-cyan'}`}>
              {camImageBusy ? t('settings.camBgUploading') : t('settings.camBgUpload')}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={camImageBusy}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  setCamImageBusy(true)
                  void (async () => {
                    try {
                      const compressed = await imageCompression(file, {
                        maxWidthOrHeight: 1280,
                        maxSizeMB: 0.35,
                        useWebWorker: true,
                        fileType: 'image/jpeg',
                      })
                      const dataUrl = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader()
                        reader.onload = () => resolve(String(reader.result))
                        reader.onerror = () => reject(reader.error)
                        reader.readAsDataURL(compressed)
                      })
                      saveCamEffectImage(dataUrl)
                      setCamImage(dataUrl)
                      applyCameraEffectToActiveCalls('image', dataUrl)
                      void startPreview()
                    } catch {
                      /* compression/read failed — keep previous image */
                    } finally {
                      setCamImageBusy(false)
                    }
                  })()
                }}
              />
            </label>
            {camImage ? (
              <button
                type="button"
                onClick={() => {
                  saveCamEffectImage(null)
                  setCamImage(null)
                  applyCameraEffectToActiveCalls(camEffect, null)
                  void startPreview()
                }}
                className="font-mono text-[9px] uppercase tracking-widest text-neon-red hover:text-text-primary"
              >
                {t('settings.camBgRemove')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={`flex items-center justify-between gap-3 px-2 py-2 ${isMd3 ? 'rounded-[20px] bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]' : 'border border-neon-cyan/20'}`}>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-neon-cyan">
            {t('settings.mediaLowBandwidth')}
          </p>
          <p className="text-[9px] text-text-muted">{t('settings.mediaLowBandwidthHint')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={lowBandwidth}
          onClick={() => {
            const next = !lowBandwidth
            setLowBandwidth(next)
            saveMediaPrefs({ lowBandwidth: next })
          }}
          className={`shrink-0 px-3 py-1.5 text-[10px] ${
            lowBandwidth
              ? (isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]' : 'border-2 border-neon-cyan bg-neon-cyan/10 font-mono uppercase tracking-widest text-neon-cyan')
              : (isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-text-muted' : 'border-2 border-border-strong/60 bg-void font-mono uppercase tracking-widest text-text-muted')
          }`}
        >
          {lowBandwidth ? '[ ON ]' : '[ OFF ]'}
        </button>
      </div>

      <div>
        <p className="mb-1 text-[9px] uppercase tracking-wider text-text-muted">
          {t('settings.mediaViewfinder')}
        </p>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          className={`mt-1 h-48 w-full object-cover ${isMd3 ? 'rounded-[20px] border border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-void' : 'border border-neon-cyan/30 bg-void'}`}
        />
        {previewError ? (
          <p className="mt-2 break-words border border-neon-red/60 px-2 py-1 font-mono text-[10px] text-neon-red">
            [!] {previewError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2 border border-neon-cyan/25 bg-void/60 px-3 py-3">
        <p className="text-[10px] uppercase tracking-[0.35em] text-neon-cyan">
          {t('settings.digitalDenTitle')}
        </p>
        <p className="text-[9px] leading-snug text-danger/90">
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
            className="border border-neon-red/70 bg-void px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40"
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
