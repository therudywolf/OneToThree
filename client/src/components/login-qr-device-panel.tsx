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
 */

export function LoginQrDevicePanel() {
  const { t } = useTranslation()
  const router = useRouter()
  const { refresh } = useAuth()

  const [isExpanded, setIsExpanded] = useState(false)
  const [signalToken, setSignalToken] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [errorLog, setErrorLog] = useState<string | null>(null)

  // QR Scanner state
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number>(0)

  const stopScanner = useCallback(() => {
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

  const startScanner = async () => {
    setScanError(null)
    setScanning(true)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        scanFrame()
      }
    } catch {
      setScanError(t('login.qrScanNoCamera'))
      setScanning(false)
    }
  }

  const scanFrame = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animFrameRef.current = requestAnimationFrame(scanFrame)
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      animFrameRef.current = requestAnimationFrame(scanFrame)
      return
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    })

    if (code?.data) {
      const token = extractQrLoginToken(code.data)
      if (token) {
        stopScanner()
        setSignalToken(token)
        // Auto-submit the scanned token
        void executeBindingWithToken(token)
        return
      }
    }

    animFrameRef.current = requestAnimationFrame(scanFrame)
  }

  const executeBindingWithToken = async (raw: string) => {
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
  }

  const executeBinding = async (e: React.FormEvent) => {
    e.preventDefault()
    await executeBindingWithToken(signalToken.trim())
  }

  return (
    <div className="mt-8 w-full border border-neutral-900 bg-black/40 p-1 backdrop-blur-sm transition-all hover:border-neutral-800">
      <div className="border border-neutral-900 p-4">
        
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
                  <div className="relative border border-neon-cyan/40 bg-black overflow-hidden">
                    <video
                      ref={videoRef}
                      className="w-full max-h-[240px] object-cover"
                      playsInline
                      muted
                    />
                    <canvas ref={canvasRef} className="hidden" />
                    {isBusy && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                        <p className="font-mono text-[10px] text-neon-cyan animate-pulse uppercase tracking-widest">
                          {t('login.qrScanProcessing')}
                        </p>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={stopScanner}
                    className="w-full border border-neon-red/50 bg-black py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-red transition-all hover:bg-neon-red/10"
                  >
                    [ {t('login.qrScanStop')} ]
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void startScanner()}
                  disabled={isBusy}
                  className="w-full border border-neon-cyan/60 bg-black py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-black disabled:opacity-20"
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
              <div className="h-[1px] flex-1 bg-neutral-900" />
              <span className="text-[8px] uppercase tracking-widest text-neutral-700">OR_MANUAL</span>
              <div className="h-[1px] flex-1 bg-neutral-900" />
            </div>

            {/* Manual Token Input */}
            <form
              onSubmit={(e) => void executeBinding(e)}
              className="space-y-4"
            >
              <div className="space-y-2">
                <p className="text-[9px] leading-relaxed text-zinc-600 uppercase tracking-widest">
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
                    className="w-full bg-zinc-950 border border-neutral-900 p-3 font-mono text-xs text-white outline-none focus:border-neon-cyan/50 placeholder:text-zinc-800"
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
                className="group relative w-full overflow-hidden border border-neon-cyan bg-black py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-black disabled:opacity-20"
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
