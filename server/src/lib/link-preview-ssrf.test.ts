import { describe, expect, it } from 'vitest'
import {
  isPrivateOrLoopbackAddress,
  normalizeToIpv4,
  requestGetPinned,
  requestGetPinnedBinary,
} from './link-preview-ssrf.js'

describe('link-preview SSRF helpers', () => {
  it('maps IPv4-mapped IPv6 loopback to blocked IPv4', () => {
    expect(normalizeToIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(isPrivateOrLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateOrLoopbackAddress('::ffff:10.0.0.1')).toBe(true)
    expect(isPrivateOrLoopbackAddress('::ffff:192.168.1.1')).toBe(true)
  })

  it('allows a public IPv4', () => {
    expect(isPrivateOrLoopbackAddress('8.8.8.8')).toBe(false)
  })

  it('blocks IPv6 loopback and ULA', () => {
    expect(isPrivateOrLoopbackAddress('::1')).toBe(true)
    expect(isPrivateOrLoopbackAddress('fd12:3456::1')).toBe(true)
    expect(isPrivateOrLoopbackAddress('fe80::1')).toBe(true)
  })

  it('rejects non-web ports so internal services cannot be probed', async () => {
    const pinned = { address: '8.8.8.8', family: 4 as const }
    const signal = new AbortController().signal
    for (const port of [6379, 5432, 9000, 22]) {
      await expect(
        requestGetPinned(new URL(`http://example.com:${port}/`), pinned, signal)
      ).rejects.toThrow('SSRF_BLOCKED')
    }
    await expect(
      requestGetPinnedBinary(
        new URL('https://media.example.com:8443/x.gif'),
        pinned,
        signal,
        1000
      )
    ).rejects.toThrow('SSRF_BLOCKED')
  })
})
