import { describe, expect, it } from 'vitest'
import { computeBitrateKbps, formatStatsForClipboard, type PeerStatsSnapshot } from '@/lib/call-stats'

describe('computeBitrateKbps', () => {
  it('returns null on the first sample (no delta yet)', () => {
    const cache = new Map<string, { bytes: number; ts: number }>()
    expect(computeBitrateKbps(cache, 'k', 1000, 1_000)).toBeNull()
  })

  it('computes kbps from byte deltas', () => {
    const cache = new Map<string, { bytes: number; ts: number }>()
    computeBitrateKbps(cache, 'k', 0, 0)
    // 125_000 bytes over 1s = 1_000_000 bits/s = 1000 kbps
    expect(computeBitrateKbps(cache, 'k', 125_000, 1_000)).toBe(1000)
  })

  it('resets on counter rollback (new track/SSRC) instead of reporting negative', () => {
    const cache = new Map<string, { bytes: number; ts: number }>()
    computeBitrateKbps(cache, 'k', 500_000, 0)
    expect(computeBitrateKbps(cache, 'k', 1_000, 1_000)).toBeNull()
    // Next sample works off the new baseline.
    expect(computeBitrateKbps(cache, 'k', 126_000, 2_000)).toBe(1000)
  })

  it('ignores undefined byte counters', () => {
    const cache = new Map<string, { bytes: number; ts: number }>()
    expect(computeBitrateKbps(cache, 'k', undefined, 1_000)).toBeNull()
  })
})

describe('formatStatsForClipboard', () => {
  it('renders one block per peer with the key numbers', () => {
    const snap: PeerStatsSnapshot = {
      peerId: 'abcdef1234',
      rttMs: 42,
      availableOutKbps: 2500,
      localCandidate: 'srflx udp 192.0.2.1:9',
      remoteCandidate: 'relay udp 198.51.100.2:3478',
      audioOut: { bitrateKbps: 48, packets: 100, packetsLost: null, jitterMs: null, codec: 'opus', frameWidth: null, frameHeight: null, fps: null },
      audioIn: { bitrateKbps: 47, packets: 100, packetsLost: 2, jitterMs: 12, codec: 'opus', frameWidth: null, frameHeight: null, fps: null },
      videoOut: { bitrateKbps: 900, packets: 100, packetsLost: null, jitterMs: null, codec: 'VP8', frameWidth: 1280, frameHeight: 720, fps: 30 },
      videoIn: { bitrateKbps: 850, packets: 100, packetsLost: 5, jitterMs: null, codec: 'VP8', frameWidth: 1280, frameHeight: 720, fps: 30 },
      qualityLimitation: 'bandwidth',
      timestamp: 0,
    }
    const text = formatStatsForClipboard([snap])
    expect(text).toContain('peer abcdef1234')
    expect(text).toContain('rtt=42ms')
    expect(text).toContain('audio out=48kbps (opus)')
    expect(text).toContain('video out=900kbps 1280x720@30 (VP8)')
    expect(text).toContain('lost=5')
  })
})
