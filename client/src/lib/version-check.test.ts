import { describe, expect, it } from 'vitest'
import { compareReleases, evaluateVersion, releasePart } from '@/lib/version-check'

describe('releasePart', () => {
  it('strips the deploy sha the server appends', () => {
    expect(releasePart('0.11.0+30c7b338')).toBe('0.11.0')
    expect(releasePart('0.11.0')).toBe('0.11.0')
    expect(releasePart('dev')).toBe('dev')
  })
})

describe('compareReleases', () => {
  it('orders by major, minor, patch', () => {
    expect(compareReleases('0.11.0', '0.10.0')).toBeGreaterThan(0)
    expect(compareReleases('0.10.9', '0.11.0')).toBeLessThan(0)
    expect(compareReleases('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareReleases('0.11.0', '0.11.0')).toBe(0)
  })
  it('treats a pre-release as older than its release', () => {
    expect(compareReleases('0.11.0-rc1', '0.11.0')).toBeLessThan(0)
    expect(compareReleases('0.11.0', '0.11.0-rc1')).toBeGreaterThan(0)
  })
  it('never ranks garbage above a real version', () => {
    expect(compareReleases('latest', '0.11.0')).toBe(0)
    expect(compareReleases('0.11.0', '')).toBe(0)
  })
})

describe('evaluateVersion', () => {
  it('web: any string difference asks for a reload', () => {
    expect(evaluateVersion('0.11.0+aaaa1111', '0.11.0+bbbb2222', false)).toBe('web')
    expect(evaluateVersion('0.11.0+aaaa1111', '0.11.0+aaaa1111', false)).toBeNull()
  })

  it('native: a redeploy of the same release is NOT an update', () => {
    // This was the permanent banner every APK and desktop build showed: the
    // bundle bakes "0.10.0", the server stamps "0.10.0+<sha>".
    expect(evaluateVersion('0.10.0', '0.10.0+30c7b338', true)).toBeNull()
    expect(evaluateVersion('0.10.0+aaaa1111', '0.10.0+bbbb2222', true)).toBeNull()
  })

  it('native: a strictly newer server release is an update', () => {
    expect(evaluateVersion('0.10.0', '0.11.0+30c7b338', true)).toBe('native')
  })

  it('native: a server rolled back below the client is not an update', () => {
    expect(evaluateVersion('0.11.0', '0.10.0+30c7b338', true)).toBeNull()
  })

  it('dev builds never prompt anywhere', () => {
    expect(evaluateVersion('dev', '0.11.0+30c7b338', false)).toBeNull()
    expect(evaluateVersion('dev', '0.11.0+30c7b338', true)).toBeNull()
  })
})
