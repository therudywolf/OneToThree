'use client'

/**
 * PROJECT 13 :: MEDIA_CHECK
 *
 * The "see yourself before anyone else does" card: a live preview with the
 * chosen background already applied, a microphone level meter, and the device
 * pickers. Used on the guest pre-join screen.
 *
 * The preview deliberately runs the SAME chain the call publishes — device
 * constraints from the saved prefs, then `createEffectedCameraTrack` — because
 * a preview that skips the effects pipeline is exactly how «убрал фон, а он всё
 * ещё уходит собеседникам» happened once already. What you see here is what is
 * published.
 *
 * Everything acquired here is released on unmount: the camera LED going out is
 * the only signal a stranger has that we let go of their hardware.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { loadCamEffectImage, loadMediaPrefs } from '@/lib/media-devices'
import { acquireMedia } from '@/lib/media-capture'
import { createEffectedCameraTrack, type CameraEffectsHandle } from '@/lib/camera-effects'
import { MediaDeviceSettings } from '@/components/media/media-device-settings'
import type { MediaPrefKind } from '@/lib/media-device-list'

/** -90 dB is silence, 0 dB is clipping; the bar maps that range. */
function levelToPercent(db: number): number {
  return Math.min(100, Math.max(0, ((db + 90) / 90) * 100))
}

export function MediaCheck() {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fxRef = useRef<CameraEffectsHandle | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  /** Bumped to force a full re-acquire; a live effect swap does not need it. */
  const [reacquire, setReacquire] = useState(0)
  const [camOn, setCamOn] = useState(true)
  const [levelDb, setLevelDb] = useState(-90)
  const [blocked, setBlocked] = useState(false)

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    // dispose() stops the raw track too, so the LED goes out.
    fxRef.current?.dispose()
    fxRef.current = null
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    const ctx = audioCtxRef.current
    audioCtxRef.current = null
    if (ctx) void ctx.close().catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const prefs = loadMediaPrefs()
      let stream: MediaStream
      try {
        stream = await acquireMedia({ video: camOn, audio: true })
      } catch {
        if (!cancelled) setBlocked(true)
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((tr) => tr.stop())
        return
      }
      setBlocked(false)
      streamRef.current = stream

      // Mic meter off the RAW capture: the published chain adds a gate, and a
      // meter that reads after it would sit at silence and look broken.
      const micTrack = stream.getAudioTracks()[0]
      if (micTrack) {
        try {
          const ctx = new AudioContext()
          audioCtxRef.current = ctx
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 1024
          ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(analyser)
          const data = new Float32Array(analyser.fftSize)
          const tick = () => {
            analyser.getFloatTimeDomainData(data)
            let sum = 0
            for (const v of data) sum += v * v
            const rms = Math.sqrt(sum / data.length)
            setLevelDb(20 * Math.log10(rms + 1e-10))
            rafRef.current = requestAnimationFrame(tick)
          }
          rafRef.current = requestAnimationFrame(tick)
        } catch {
          /* no meter — the picker still works */
        }
      }

      const rawCam = stream.getVideoTracks()[0]
      if (!rawCam) return
      let shown: MediaStreamTrack = rawCam
      if (prefs.camEffect !== 'none') {
        try {
          const fx = await createEffectedCameraTrack(rawCam, {
            kind: prefs.camEffect,
            imageDataUrl: loadCamEffectImage(),
            blurPx: prefs.camBlurPx,
          })
          if (cancelled) {
            fx?.dispose()
            return
          }
          if (fx) {
            fxRef.current = fx
            shown = fx.processedTrack
          }
        } catch {
          /* effects unavailable — show the raw camera rather than nothing */
        }
      }
      const el = videoRef.current
      if (el) {
        el.srcObject = new MediaStream([shown])
        void el.play().catch(() => {})
      }
    })()

    return () => {
      cancelled = true
      teardown()
    }
  }, [camOn, reacquire, teardown])

  const onPrefChange = useCallback((kind: MediaPrefKind) => {
    if (kind === 'speaker') return // nothing is playing back here
    if (kind === 'background' && fxRef.current) {
      const prefs = loadMediaPrefs()
      fxRef.current.setEffect(prefs.camEffect, loadCamEffectImage())
      return
    }
    setReacquire((n) => n + 1)
  }, [])

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl border border-border-strong bg-void">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className={`aspect-video w-full object-cover ${camOn ? '' : 'invisible'}`}
        />
        {!camOn ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-text-muted">
            {t('meet.previewOff')}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setCamOn((v) => !v)}
          title={camOn ? t('meet.previewToggleCamOff') : t('meet.previewToggleCamOn')}
          className="absolute bottom-2 right-2 rounded-lg border border-border-strong bg-surface-elevated px-2 py-1 text-[11px] text-text-muted transition hover:text-text-primary"
        >
          {camOn ? t('meet.previewToggleCamOff') : t('meet.previewToggleCamOn')}
        </button>
      </div>

      <div>
        <span className="mb-1 block text-xs text-text-muted">{t('meet.micLevel')}</span>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border-strong">
          <div
            className="h-full rounded-full bg-neon-cyan transition-[width] duration-75"
            style={{ width: `${levelToPercent(levelDb)}%` }}
          />
        </div>
      </div>

      {blocked ? (
        <p className="text-xs text-neon-red" role="alert">
          {t('meet.previewBlocked')}
        </p>
      ) : null}

      <MediaDeviceSettings onChange={onPrefChange} />
      <p className="text-xs text-text-muted">{t('meet.checkHint')}</p>
    </div>
  )
}
