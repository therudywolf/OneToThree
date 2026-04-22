import { describe, expect, it } from 'vitest'
import {
  isPrivateOrLoopbackAddress,
  normalizeToIpv4,
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
})
