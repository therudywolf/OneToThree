'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { ensureClientDeviceId } from '@/lib/api/auth'
import { buildQrLoginUrl, extractQrLoginToken, postQrLogin } from '@/lib/api/auth-qr'
import { useTranslation } from '@/hooks/use-translation'
import jsQR from 'jsqr'

/**
 * PROJECT 13 :: NODE_LINKING_INTERFACE
 * Level: Authority Layer (Hardware Binding)
 * Vibe: Clinical Pure / Terminal Noir / Zero-Trust
 *
 * QR scan pipeline:
 *   1. Try native BarcodeDetector('qr_code') — much faster & more robust.
 *   2. Fallback to jsQR on a hidden canvas if BarcodeDetector is missing.
 *   3. Wait for `loadedmetadata` on the <video> element before starting the
 *      scan loop so videoWidth/videoHeight are stable (iOS Safari tends to
 *      report 0/0 for several frames after `play()` resolves).
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
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'QR_CAMERA_DENIED'
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'QR_CAMERA_NOT_FOUND'
    }
    if (name === 'NotReadableError') {
      return 'QR_CAMERA_BUSY'
    }
  }
  return 'QR_CAMERA_FAILED'
}

export function LoginQrDevicePanel() {
  const { t } = useTranslation()
  const router = useRouter()
  const { refresh } = useAuth()

  const [isExpanded, setIsExpanded] = useState(false)
  const [signalToken, setSignalToken] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [errorLog, setErrorLog] = useState<string | null>(null)

  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number>(0)
  const scanAbortRef = useRef<boolean>(false)

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
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setScanning(false)
  }, [])

  useEffect(() => {
    return () => { stopScanner() }
  }, [stopScanner])

  const executeBindingWithToken = useCallback(async (raw: string) => {
    const token = extractQrLoginToken(raw)
    if (!token) {
      setErrorLog(t('login.qrTokenInvalid'))
      return
    }

    setIsBusy(true)
    setErrorLog(null)

    try {
      ensureClientDeviceId()
      const result = await postQrLogin(token)
      if (result.ok === 'needs_2fa') {
        router.push(buildQrLoginUrl(token))
        return
      }
      await refresh()
      router.replace('/')
      router.refresh()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.replace(/_/g, ' ') : t('errors.generic')
      setErrorLog(`BIND_FAULT // ${msg.toUpperCase()}`)
    } finally {
      setIsBusy(false)
    }
  }, [refresh, router, t])

  const handleScanHit = useCallback((raw: string) => {
    const token = extractQrLoginToken(raw)
    if (!token) return false
    stopScanner()
    setSignalToken(token)
    void executeBindingWithToken(token)
    return true
  }, [executeBindingWithToken, stopScanner])

  const runScanLoop = useCallback(async (detector: BarcodeDetectorLike | null) => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

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
          if (codes.length > 0) {
            for (const code of codes) {
              if (code.rawValue && handleScanHit(code.rawValue)) return
            }
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
            if (code?.data && handleScanHit(code.data)) return
          }
        }
      } catch (err) {
        console.warn('[QR] scan-frame error:', err)
      }

      animFrameRef.current = requestAnimationFrame(() => { void tick() })
    }

    await tick()
  }, [handleScanHit])

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
        // Fallback to the default camera if the environment-facing constraint fails.
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

      // Wait for dimensions to be available. `loadedmetadata` is reliable;
      // on iOS, play() may resolve before the frame has real dimensions.
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

  const executeBinding = async (e: React.FormEvent) => {
    e.preventDefault()
    await executeBindingWithToken(signalToken.trim())
  }

  return (
    <div className="mt-8 w-full border border-border-strong bg-void/40 p-1 backdrop-blur-sm transition-all hover:border-border-strong">
      <div className="border border-border-strong p-4">

        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          data-testid="qr-link-toggle"
          className="flex w-full items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-colors hover:text-neon-red"
        >
          <span>{t('login.qrLinkSection')}</span>
          <span className="text-xs opacity-50">{isExpanded ? '[ − ]' : '[ + ]'}</span>
        </button>

        {isExpanded && (
          <div className="mt-6 space-y-4 animate-in fade-in slide-in-from-top-1">
            {/* QR Camera Scanner */}
            <div className="space-y-3">
              {scanning ? (
                <div className="space-y-2">
                  <p className="text-[9px] leading-relaxed text-neon-cyan uppercase tracking-widest">
                    // {t('login.qrScanHint')}
                  </p>
                  <div className="relative border border-neon-cyan/40 bg-void overflow-hidden">
                    <video
                      ref={videoRef}
                      className="w-full max-h-[240px] object-cover"
                      playsInline
                      muted
                      autoPlay
                    />
                    <canvas ref={canvasRef} className="hidden" />
                    {isBusy && (
                      <div className="absolute inset-0 flex items-center justify-center bg-void/80">
                        <p className="font-mono text-[10px] text-neon-cyan animate-pulse uppercase tracking-widest">
                          {t('login.qrScanProcessing')}
                        </p>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={stopScanner}
                    className="w-full border border-neon-red/50 bg-void py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-red transition-all hover:bg-neon-red/10"
                  >
                    [ {t('login.qrScanStop')} ]
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void startScanner()}
                  disabled={isBusy}
                  className="w-full border border-neon-cyan/60 bg-void py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-text-primary disabled:opacity-20"
                >
                  {`>> ${t('login.qrScanStart')}`}
                </button>
              )}
              {scanError && (
                <div className="border border-neon-red/30 bg-neon-red/5 p-2 font-mono text-[9px] text-neon-red uppercase tracking-widest">
                  [!] {scanError}
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="h-[1px] flex-1 bg-void" />
              <span className="text-[8px] uppercase tracking-widest text-text-muted/70">OR_MANUAL</span>
              <div className="h-[1px] flex-1 bg-void" />
            </div>

            {/* Manual Token Input */}
            <form
              onSubmit={(e) => void executeBinding(e)}
              className="space-y-4"
            >
              <div className="space-y-2">
                <p className="text-[9px] leading-relaxed text-text-muted/70 uppercase tracking-widest">
                  // {t('login.qrLinkHint')}
                </p>

                <div className="relative">
                  <input
                    data-testid="qr-token-input"
                    type="text"
                    value={signalToken}
                    onChange={(e) => setSignalToken(e.target.value)}
                    placeholder={t('login.qrTokenPlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full bg-void border border-border-strong p-3 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/50 placeholder:text-text-muted/50"
                  />
                  <div className="absolute bottom-0 left-0 h-[1px] w-0 bg-neon-cyan transition-all duration-500 group-focus-within:w-full" />
                </div>
              </div>

              {errorLog && (
                <div className="border border-neon-red/30 bg-neon-red/5 p-2 font-mono text-[9px] text-neon-red uppercase tracking-widest">
                  [!] {errorLog}
                </div>
              )}

              <button
                type="submit"
                disabled={isBusy || !signalToken.trim()}
                className="group relative w-full overflow-hidden border border-neon-cyan bg-void py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-text-primary disabled:opacity-20"
              >
                <span className="relative z-10">
                  {isBusy ? ':: SYNCING_SIGNAL ::' : `>> ${t('login.qrLinkSubmit')}`}
                </span>
                <div className="absolute inset-0 z-0 opacity-0 transition-opacity group-hover:bg-neon-cyan group-hover:opacity-10" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
