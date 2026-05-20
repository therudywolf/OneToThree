'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import jsQR from 'jsqr'

/**
 * Reusable QR camera scanner.
 *
 * Pipeline:
 *   1. Native BarcodeDetector('qr_code') when available (fast, robust).
 *   2. jsQR fallback on a hidden canvas otherwise.
 *   3. Waits for `loadedmetadata` so videoWidth/Height are stable (iOS Safari
 *      reports 0/0 for several frames after play()).
 *
 * `onScan` is called with each decoded string; return true to stop scanning.
 */

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>
}

interface BarcodeDetectorConstructor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

async function getQrDetector(): Promise<BarcodeDetectorLike | null> {
  if (typeof window === 'undefined') return null
  const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector
  if (!Ctor) return null
  try {
    const supported = (await Ctor.getSupportedFormats?.()) ?? []
    if (supported.length && !supported.includes('qr_code')) return null
    return new Ctor({ formats: ['qr_code'] })
  } catch {
    return null
  }
}

function diagnoseMediaError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = String((err as { name: string }).name)
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'QR_CAMERA_DENIED'
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'QR_CAMERA_NOT_FOUND'
    if (name === 'NotReadableError') return 'QR_CAMERA_BUSY'
  }
  return 'QR_CAMERA_FAILED'
}

type QrScannerProps = {
  /** Called with each decoded QR payload. Return true to stop the scanner. */
  onScan: (raw: string) => boolean | Promise<boolean>
  /** Overlay shown while the parent processes a hit. */
  processing?: boolean
  isRetro?: boolean
}

export function QrScanner({ onScan, processing = false, isRetro = false }: QrScannerProps) {
  const { t } = useTranslation()
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number>(0)
  const scanAbortRef = useRef<boolean>(false)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  const scanErrorText = (() => {
    if (!scanError) return null
    if (scanError === 'QR_CAMERA_DENIED') return t('login.qrScanDenied')
    if (scanError === 'QR_CAMERA_NOT_FOUND') return t('login.qrScanNotFound')
    if (scanError === 'QR_CAMERA_BUSY') return t('login.qrScanBusy')
    if (scanError === 'QR_CAMERA_FAILED') return t('login.qrScanFailed')
    return scanError
  })()

  const stopScanner = useCallback(() => {
    scanAbortRef.current = true
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = 0
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setScanning(false)
  }, [])

  useEffect(() => () => stopScanner(), [stopScanner])

  const handleHit = useCallback(async (raw: string): Promise<boolean> => {
    const consumed = await onScanRef.current(raw)
    if (consumed) stopScanner()
    return consumed
  }, [stopScanner])

  const runScanLoop = useCallback(async (detector: BarcodeDetectorLike | null) => {
    scanAbortRef.current = false

    const tick = async () => {
      if (scanAbortRef.current) return
      const v = videoRef.current
      const c = canvasRef.current
      if (!v || !c) return
      if (v.readyState < v.HAVE_CURRENT_DATA || !v.videoWidth || !v.videoHeight) {
        animFrameRef.current = requestAnimationFrame(() => { void tick() })
        return
      }

      try {
        if (detector) {
          const codes = await detector.detect(v)
          for (const code of codes) {
            if (code.rawValue && (await handleHit(code.rawValue))) return
          }
        } else {
          c.width = v.videoWidth
          c.height = v.videoHeight
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (ctx) {
            ctx.drawImage(v, 0, 0, c.width, c.height)
            const imageData = ctx.getImageData(0, 0, c.width, c.height)
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert',
            })
            if (code?.data && (await handleHit(code.data))) return
          }
        }
      } catch (err) {
        console.warn('[QR] scan-frame error:', err)
      }

      if (!scanAbortRef.current) {
        animFrameRef.current = requestAnimationFrame(() => { void tick() })
      }
    }

    await tick()
  }, [handleHit])

  const startScanner = useCallback(async () => {
    setScanError(null)
    setScanning(true)
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setScanError(t('login.qrScanNoCamera'))
        setScanning(false)
        return
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        if (name === 'OverconstrainedError' || name === 'NotFoundError') {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        } else {
          throw err
        }
      }

      streamRef.current = stream
      const video = videoRef.current
      if (!video) {
        stopScanner()
        return
      }
      video.srcObject = stream
      video.setAttribute('playsinline', 'true')
      video.muted = true

      await new Promise<void>((resolve) => {
        if (video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0) {
          resolve()
          return
        }
        const onReady = () => {
          video.removeEventListener('loadedmetadata', onReady)
          resolve()
        }
        video.addEventListener('loadedmetadata', onReady, { once: true })
      })

      try {
        await video.play()
      } catch (err) {
        console.warn('[QR] video.play() rejected:', err)
      }

      const detector = await getQrDetector()
      void runScanLoop(detector)
    } catch (err) {
      console.error('[QR] failed to start scanner:', err)
      setScanError(diagnoseMediaError(err))
      setScanning(false)
      stopScanner()
    }
  }, [runScanLoop, stopScanner, t])

  return (
    <div className="space-y-3">
      {scanning ? (
        <div className="space-y-2">
          <p className="text-[9px] uppercase tracking-widest leading-relaxed text-neon-cyan">
            // {t('login.qrScanHint')}
          </p>
          <div className={`relative overflow-hidden ${isRetro ? 'p13-classic-input' : 'border border-neon-cyan/40 bg-void'}`}>
            <video
              ref={videoRef}
              className="max-h-[240px] w-full object-cover"
              playsInline
              muted
              autoPlay
            />
            <canvas ref={canvasRef} className="hidden" />
            {processing && (
              <div className="absolute inset-0 flex items-center justify-center bg-void/80">
                <p className="font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
                  {t('login.qrScanProcessing')}
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={stopScanner}
            className={`w-full border py-2 text-[10px] transition-all ${
              isRetro
                ? 'p13-classic-button p13-classic-button--danger'
                : 'border-neon-red/50 bg-void font-mono uppercase tracking-[0.3em] text-neon-red hover:bg-neon-red/10'
            }`}
          >
            [ {t('login.qrScanStop')} ]
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void startScanner()}
          className={`w-full border py-2.5 text-[10px] transition-all ${
            isRetro
              ? 'p13-classic-button'
              : 'border-neon-cyan/60 bg-void font-mono uppercase tracking-[0.3em] text-neon-cyan hover:bg-neon-cyan hover:text-text-primary'
          }`}
        >
          {`>> ${t('login.qrScanStart')}`}
        </button>
      )}
      {scanErrorText && (
        <div className="border border-neon-red/30 bg-neon-red/5 p-2 font-mono text-[9px] uppercase tracking-widest text-neon-red">
          [!] {scanErrorText}
        </div>
      )}
    </div>
  )
}
