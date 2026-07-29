'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { decryptBinaryWithRing } from '@/lib/crypto'
import { getDownloadUrl } from '@/lib/api/storage'

type Props = {
  mediaPath: string
  mediaIv: string
  mimeType: string
  sharedKey: CryptoKey | null
}

const BAR_COUNT = 52

function extractWaveform(audioBuffer: AudioBuffer, barCount: number): number[] {
  const channel = audioBuffer.getChannelData(0)
  const blockSize = Math.floor(channel.length / barCount)
  const peaks: number[] = []
  for (let i = 0; i < barCount; i++) {
    const start = i * blockSize
    let max = 0
    for (let j = 0; j < blockSize; j++) {
      const abs = Math.abs(channel[start + j] ?? 0)
      if (abs > max) max = abs
    }
    peaks.push(max)
  }
  const maxPeak = Math.max(...peaks, 0.001)
  return peaks.map((p) => Math.max(0.06, p / maxPeak))
}

export function SecureAudioPlayer({ mediaPath, mediaIv, mimeType, sharedKey }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [waveform, setWaveform] = useState<number[]>(Array(BAR_COUNT).fill(0.06))
  const waveformReady = waveform.some((v) => v > 0.1)

  useEffect(() => {
    if (!sharedKey || !mediaPath || !mediaIv) { setLoadErr('MISSING_KEY_OR_DATA'); return }
    let isSubscribed = true
    setLoadErr(null)
    const run = async () => {
      try {
        const s3Url = await getDownloadUrl(mediaPath)
        const res = await fetch(s3Url)
        if (!res.ok) throw new Error('FETCH_FAILED')
        const encryptedBuf = await res.arrayBuffer()
        const decryptedBuf = await decryptBinaryWithRing(sharedKey, encryptedBuf, mediaIv)
        const blobMime = (mimeType || 'audio/webm').split(';')[0]
        const blob = new Blob([decryptedBuf], { type: blobMime })
        if (!isSubscribed) return
        const url = URL.createObjectURL(blob)
        blobUrlRef.current = url
        setObjectUrl(url)
        if (typeof AudioContext !== 'undefined') {
          try {
            const ctx = new AudioContext()
            const bufCopy = decryptedBuf.slice(0)
            const ab = await ctx.decodeAudioData(bufCopy)
            void ctx.close()
            if (isSubscribed) setWaveform(extractWaveform(ab, BAR_COUNT))
          } catch { /* graceful degrade */ }
        }
      } catch (err) {
        console.error('Audio decryption error:', err)
        if (isSubscribed) setLoadErr('DECRYPTION_FAILED')
      }
    }
    void run()
    return () => {
      isSubscribed = false
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null }
      setObjectUrl(null)
      setWaveform(Array(BAR_COUNT).fill(0.06))
    }
  }, [mediaPath, mediaIv, mimeType, sharedKey])

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (playing) el.pause()
    else void el.play()
  }, [playing])

  const handleWaveformClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current
    if (!el || !el.duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    el.currentTime = frac * el.duration
    setProgress(frac * 100)
  }, [])

  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return m + ':' + s.toString().padStart(2, '0')
  }

  if (loadErr) return <p className="font-mono text-[10px] text-neon-red">[!] {loadErr}</p>

  if (!sharedKey || !objectUrl) {
    return (
      <div className="mt-2 max-w-xs">
        <p className="animate-pulse font-mono text-[10px] text-neon-cyan/60">DECRYPTING...</p>
      </div>
    )
  }

  const playedBars = Math.round((progress / 100) * BAR_COUNT)

  return (
    <div className="p13-audio-player mt-1 flex max-w-[280px] items-center gap-2 rounded-[var(--p13-radius-msg)] border border-neon-cyan/20 bg-void/60 px-2 py-1.5">
      <audio
        ref={audioRef}
        src={objectUrl}
        preload="auto"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); setCurrentTime(0) }}
        onDurationChange={() => { if (audioRef.current) setDuration(audioRef.current.duration || 0) }}
        onTimeUpdate={() => {
          const el = audioRef.current
          if (!el?.duration) return
          setCurrentTime(el.currentTime)
          setProgress((el.currentTime / el.duration) * 100)
        }}
      />

      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-neon-cyan/40 bg-void text-neon-cyan transition-colors hover:bg-neon-cyan/10"
      >
        {playing ? (
          <svg viewBox="0 0 10 12" className="h-3 w-3 fill-current">
            <rect x="0" y="0" width="3.5" height="12" />
            <rect x="6.5" y="0" width="3.5" height="12" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 12" className="h-3 w-3 fill-current">
            <polygon points="0,0 10,6 0,12" />
          </svg>
        )}
      </button>

      <div
        role="slider"
        aria-label="Audio progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        tabIndex={0}
        onClick={handleWaveformClick}
        onKeyDown={(e) => {
          const el = audioRef.current
          if (!el) return
          if (e.key === 'ArrowRight') el.currentTime = Math.min(el.duration, el.currentTime + 5)
          if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5)
        }}
        className="flex h-8 flex-1 cursor-pointer items-center gap-[1.5px]"
        style={{ touchAction: 'none' }}
      >
        {waveform.map((h, i) => (
          <div
            key={i}
            className="min-w-[2px] flex-1 rounded-full transition-colors duration-75"
            style={{
              height: Math.round(h * 100) + '%',
              backgroundColor: !waveformReady
                ? 'rgba(0,255,255,0.2)'
                : i < playedBars
                ? 'rgba(0,255,255,0.85)'
                : 'rgba(0,255,255,0.25)',
            }}
          />
        ))}
      </div>

      <span className="shrink-0 font-mono text-[9px] tabular-nums text-text-muted">
        {(playing || currentTime > 0) ? (fmt(currentTime) + '/' + fmt(duration)) : fmt(duration)}
      </span>
    </div>
  )
}
