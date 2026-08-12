/**
 * PROJECT 13 :: CALL_STATS_SAMPLER
 * Level: Diagnostics (WebRTC getStats)
 *
 * Turns raw RTCStatsReport dumps into a compact per-peer snapshot for the
 * in-call debug panel: bitrates (computed from byte deltas between samples),
 * resolution/fps, packet loss, jitter, RTT, codecs and the selected ICE
 * candidate pair. Pure data — no DOM.
 */

export type DirectionStats = {
  bitrateKbps: number | null
  packets: number | null
  packetsLost: number | null
  jitterMs: number | null
  codec: string | null
  /** Video only. */
  frameWidth: number | null
  frameHeight: number | null
  fps: number | null
}

export type PeerStatsSnapshot = {
  peerId: string
  rttMs: number | null
  availableOutKbps: number | null
  localCandidate: string | null
  remoteCandidate: string | null
  audioOut: DirectionStats
  audioIn: DirectionStats
  videoOut: DirectionStats
  videoIn: DirectionStats
  /** cpu / bandwidth / none — why the encoder is limiting quality. */
  qualityLimitation: string | null
  timestamp: number
}

function emptyDirection(): DirectionStats {
  return {
    bitrateKbps: null,
    packets: null,
    packetsLost: null,
    jitterMs: null,
    codec: null,
    frameWidth: null,
    frameHeight: null,
    fps: null,
  }
}

type ByteCache = Map<string, { bytes: number; ts: number }>

/** Compute kbps from cumulative byte counters between two samples. */
export function computeBitrateKbps(
  cache: ByteCache,
  key: string,
  bytes: number | undefined,
  nowMs: number
): number | null {
  if (typeof bytes !== 'number') return null
  const prev = cache.get(key)
  cache.set(key, { bytes, ts: nowMs })
  if (!prev || nowMs <= prev.ts || bytes < prev.bytes) return null
  const deltaBits = (bytes - prev.bytes) * 8
  const deltaSec = (nowMs - prev.ts) / 1000
  return Math.round(deltaBits / deltaSec / 1000)
}

/** Format a candidate for display: `host udp 192.0.2.1:3478`. */
function describeCandidate(c: Record<string, unknown> | undefined): string | null {
  if (!c) return null
  const type = typeof c.candidateType === 'string' ? c.candidateType : '?'
  const protocol = typeof c.protocol === 'string' ? c.protocol : ''
  const addr = typeof c.address === 'string' ? c.address : (typeof c.ip === 'string' ? c.ip : '')
  const port = typeof c.port === 'number' ? `:${c.port}` : ''
  return [type, protocol, addr ? `${addr}${port}` : ''].filter(Boolean).join(' ')
}

export class CallStatsSampler {
  private byteCache: ByteCache = new Map()

  async sample(peerId: string, pc: RTCPeerConnection): Promise<PeerStatsSnapshot> {
    const now = Date.now()
    const snapshot: PeerStatsSnapshot = {
      peerId,
      rttMs: null,
      availableOutKbps: null,
      localCandidate: null,
      remoteCandidate: null,
      audioOut: emptyDirection(),
      audioIn: emptyDirection(),
      videoOut: emptyDirection(),
      videoIn: emptyDirection(),
      qualityLimitation: null,
      timestamp: now,
    }

    let stats: RTCStatsReport
    try {
      stats = await pc.getStats()
    } catch {
      return snapshot
    }

    const byId = new Map<string, Record<string, unknown>>()
    stats.forEach((r) => byId.set(r.id, r as unknown as Record<string, unknown>))

    const codecName = (codecId: unknown): string | null => {
      if (typeof codecId !== 'string') return null
      const codec = byId.get(codecId)
      const mime = codec && typeof codec.mimeType === 'string' ? codec.mimeType : null
      return mime ? mime.replace(/^(audio|video)\//, '') : null
    }

    stats.forEach((report) => {
      const r = report as unknown as Record<string, unknown>
      if (report.type === 'outbound-rtp') {
        const kind = (r.kind ?? r.mediaType) as string
        const dir = kind === 'video' ? snapshot.videoOut : snapshot.audioOut
        dir.bitrateKbps = computeBitrateKbps(
          this.byteCache,
          `${peerId}:out:${report.id}`,
          r.bytesSent as number | undefined,
          now
        )
        if (typeof r.packetsSent === 'number') dir.packets = r.packetsSent
        dir.codec = codecName(r.codecId) ?? dir.codec
        if (kind === 'video') {
          if (typeof r.frameWidth === 'number') dir.frameWidth = r.frameWidth
          if (typeof r.frameHeight === 'number') dir.frameHeight = r.frameHeight
          if (typeof r.framesPerSecond === 'number') dir.fps = Math.round(r.framesPerSecond)
          if (typeof r.qualityLimitationReason === 'string' && r.qualityLimitationReason !== 'none') {
            snapshot.qualityLimitation = r.qualityLimitationReason
          }
        }
      } else if (report.type === 'inbound-rtp') {
        const kind = (r.kind ?? r.mediaType) as string
        const dir = kind === 'video' ? snapshot.videoIn : snapshot.audioIn
        dir.bitrateKbps = computeBitrateKbps(
          this.byteCache,
          `${peerId}:in:${report.id}`,
          r.bytesReceived as number | undefined,
          now
        )
        if (typeof r.packetsReceived === 'number') dir.packets = r.packetsReceived
        if (typeof r.packetsLost === 'number') dir.packetsLost = r.packetsLost
        if (typeof r.jitter === 'number') dir.jitterMs = Math.round(r.jitter * 1000)
        dir.codec = codecName(r.codecId) ?? dir.codec
        if (kind === 'video') {
          if (typeof r.frameWidth === 'number') dir.frameWidth = r.frameWidth
          if (typeof r.frameHeight === 'number') dir.frameHeight = r.frameHeight
          if (typeof r.framesPerSecond === 'number') dir.fps = Math.round(r.framesPerSecond)
        }
      } else if (report.type === 'candidate-pair') {
        const isSelected =
          r.state === 'succeeded' && (r.nominated === true || r.selected === true || r.nominated === undefined)
        if (isSelected) {
          if (typeof r.currentRoundTripTime === 'number') {
            snapshot.rttMs = Math.round(r.currentRoundTripTime * 1000)
          }
          if (typeof r.availableOutgoingBitrate === 'number') {
            snapshot.availableOutKbps = Math.round(r.availableOutgoingBitrate / 1000)
          }
          snapshot.localCandidate = describeCandidate(byId.get(r.localCandidateId as string))
          snapshot.remoteCandidate = describeCandidate(byId.get(r.remoteCandidateId as string))
        }
      }
    })

    return snapshot
  }

  reset(): void {
    this.byteCache.clear()
  }
}

/** Render a snapshot as plain text for copy-to-clipboard diagnostics. */
export function formatStatsForClipboard(snaps: PeerStatsSnapshot[]): string {
  const lines: string[] = [`# call diagnostics @ ${new Date().toISOString()}`]
  for (const s of snaps) {
    lines.push(`peer ${s.peerId}`)
    lines.push(`  rtt=${s.rttMs ?? '?'}ms availOut=${s.availableOutKbps ?? '?'}kbps limit=${s.qualityLimitation ?? 'none'}`)
    lines.push(`  ice local=[${s.localCandidate ?? '?'}] remote=[${s.remoteCandidate ?? '?'}]`)
    lines.push(`  audio out=${s.audioOut.bitrateKbps ?? '?'}kbps (${s.audioOut.codec ?? '?'}) in=${s.audioIn.bitrateKbps ?? '?'}kbps lost=${s.audioIn.packetsLost ?? 0} jitter=${s.audioIn.jitterMs ?? '?'}ms`)
    lines.push(`  video out=${s.videoOut.bitrateKbps ?? '?'}kbps ${s.videoOut.frameWidth ?? '?'}x${s.videoOut.frameHeight ?? '?'}@${s.videoOut.fps ?? '?'} (${s.videoOut.codec ?? '?'})`)
    lines.push(`  video in=${s.videoIn.bitrateKbps ?? '?'}kbps ${s.videoIn.frameWidth ?? '?'}x${s.videoIn.frameHeight ?? '?'}@${s.videoIn.fps ?? '?'} lost=${s.videoIn.packetsLost ?? 0}`)
  }
  return lines.join('\n')
}
