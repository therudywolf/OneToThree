import { describe, expect, it } from 'vitest'
import { mungeOpusStereo } from '@/lib/sdp-munge'

const SDP_WITH_FMTP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
].join('\r\n')

describe('mungeOpusStereo', () => {
  it('appends stereo + bitrate params to the existing opus fmtp', () => {
    const out = mungeOpusStereo(SDP_WITH_FMTP)
    const fmtp = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111'))
    expect(fmtp).toContain('minptime=10')
    expect(fmtp).toContain('useinbandfec=1')
    expect(fmtp).toContain('stereo=1')
    expect(fmtp).toContain('sprop-stereo=1')
    expect(fmtp).toContain('maxaveragebitrate=192000')
  })

  it('does not touch non-opus fmtp/rtpmap lines', () => {
    const out = mungeOpusStereo(SDP_WITH_FMTP)
    expect(out).toContain('a=rtpmap:96 VP8/90000')
    expect(out.split('\r\n').filter((l) => l.startsWith('a=fmtp:96'))).toHaveLength(0)
  })

  it('synthesizes an fmtp line when opus has none', () => {
    const sdp = [
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=sendrecv',
    ].join('\r\n')
    const out = mungeOpusStereo(sdp).split('\r\n')
    const idx = out.findIndex((l) => l.startsWith('a=rtpmap:111'))
    expect(out[idx + 1]).toMatch(/^a=fmtp:111 stereo=1;sprop-stereo=1/)
  })

  it('is idempotent and preserves existing parameter values', () => {
    const withCustom = SDP_WITH_FMTP.replace(
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'a=fmtp:111 minptime=10;stereo=0'
    )
    const once = mungeOpusStereo(withCustom)
    // stereo=0 already present — must NOT be overridden or duplicated.
    // (`sprop-stereo=1` still gets added; the boundary regex must not match it.)
    const fmtp = once.split('\r\n').find((l) => l.startsWith('a=fmtp:111'))
    expect(fmtp).toContain('stereo=0')
    expect(fmtp).not.toMatch(/(^|[ ;])stereo=1/)
    expect(mungeOpusStereo(once)).toBe(once)
  })

  it('passes through SDP without opus untouched', () => {
    const sdp = 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000'
    expect(mungeOpusStereo(sdp)).toBe(sdp)
  })
})
