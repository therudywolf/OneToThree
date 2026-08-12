'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Copy, Check } from 'lucide-react'
import { CallStatsSampler, formatStatsForClipboard, type PeerStatsSnapshot } from '@/lib/call-stats'
import { useTranslation } from '@/hooks/use-translation'

/**
 * PROJECT 13 :: CALL_DEBUG_PANEL
 * Live WebRTC diagnostics: bitrates, resolution/fps, packet loss, jitter, RTT,
 * codecs and the selected ICE pair per peer. Polls getStats() once a second
 * while open. Works for both the 1:1 mesh and the group mesh (pass the pcs).
 */
export function CallDebugPanel({
  peers,
  labels,
  extraLines = [],
  onClose,
}: {
  peers: Record<string, RTCPeerConnection>
  labels: Record<string, string>
  /** Transport-level notes prepended above the per-peer stats (e.g. relay mode). */
  extraLines?: string[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [snaps, setSnaps] = useState<PeerStatsSnapshot[]>([])
  const [copied, setCopied] = useState(false)
  const samplerRef = useRef<CallStatsSampler | null>(null)

  useEffect(() => {
    const sampler = new CallStatsSampler()
    samplerRef.current = sampler
    let cancelled = false
    const poll = async () => {
      const entries = Object.entries(peers)
      const out: PeerStatsSnapshot[] = []
      for (const [peerId, pc] of entries) {
        out.push(await sampler.sample(peerId, pc))
      }
      if (!cancelled) setSnaps(out)
    }
    void poll()
    const id = window.setInterval(() => void poll(), 1000)
    return () => {
      cancelled = true
      window.clearInterval(id)
      sampler.reset()
    }
  }, [peers])

  const fmt = (v: number | null | undefined, suffix = '') =>
    v === null || v === undefined ? '—' : `${v}${suffix}`

  const copyDiagnostics = () => {
    const text = [...extraLines, formatStatsForClipboard(snaps)].join('\n')
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-void/95 font-mono backdrop-blur-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border-strong px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-neon-cyan">
          {t('call.debugTitle')}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyDiagnostics}
            className="flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-neon-cyan"
            title={t('call.debugCopy')}
            aria-label={t('call.debugCopy')}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-text-primary"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2 text-[10px] leading-relaxed">
        {extraLines.map((line) => (
          <p key={line} className="text-text-muted">{line}</p>
        ))}
        {snaps.length === 0 ? (
          <p className="text-text-muted">{t('call.debugNoPeers')}</p>
        ) : (
          snaps.map((s) => (
            <div key={s.peerId} className="border border-border-strong/60 p-2">
              <p className="mb-1 truncate text-neon-cyan">
                {labels[s.peerId] ?? s.peerId.slice(0, 8)}
              </p>
              <table className="w-full border-collapse text-left">
                <tbody>
                  <tr>
                    <td className="pr-2 text-text-muted">RTT</td>
                    <td className="text-text-primary">{fmt(s.rttMs, ' ms')}</td>
                    <td className="pr-2 text-text-muted">{t('call.debugAvail')}</td>
                    <td className="text-text-primary">{fmt(s.availableOutKbps, ' kbps')}</td>
                  </tr>
                  <tr>
                    <td className="pr-2 text-text-muted">ICE</td>
                    <td colSpan={3} className="break-all text-text-primary">
                      {s.localCandidate ?? '—'} ⇄ {s.remoteCandidate ?? '—'}
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-2 text-text-muted">A↑</td>
                    <td className="text-text-primary">
                      {fmt(s.audioOut.bitrateKbps, ' kbps')} {s.audioOut.codec ?? ''}
                    </td>
                    <td className="pr-2 text-text-muted">A↓</td>
                    <td className="text-text-primary">
                      {fmt(s.audioIn.bitrateKbps, ' kbps')}
                      {s.audioIn.jitterMs !== null ? ` j${s.audioIn.jitterMs}ms` : ''}
                      {s.audioIn.packetsLost ? ` lost ${s.audioIn.packetsLost}` : ''}
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-2 text-text-muted">V↑</td>
                    <td className="text-text-primary">
                      {fmt(s.videoOut.bitrateKbps, ' kbps')}
                      {s.videoOut.frameWidth ? ` ${s.videoOut.frameWidth}×${s.videoOut.frameHeight}@${s.videoOut.fps ?? '?'}` : ''}
                      {s.videoOut.codec ? ` ${s.videoOut.codec}` : ''}
                    </td>
                    <td className="pr-2 text-text-muted">V↓</td>
                    <td className="text-text-primary">
                      {fmt(s.videoIn.bitrateKbps, ' kbps')}
                      {s.videoIn.frameWidth ? ` ${s.videoIn.frameWidth}×${s.videoIn.frameHeight}@${s.videoIn.fps ?? '?'}` : ''}
                      {s.videoIn.packetsLost ? ` lost ${s.videoIn.packetsLost}` : ''}
                    </td>
                  </tr>
                  {s.qualityLimitation ? (
                    <tr>
                      <td className="pr-2 text-text-muted">{t('call.debugLimited')}</td>
                      <td colSpan={3} className="text-accent-2">{s.qualityLimitation}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
