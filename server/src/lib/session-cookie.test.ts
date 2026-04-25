import { serialize } from 'cookie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseLastFmSessionValue } from './session-cookie.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('parseLastFmSessionValue', () => {
  it('prefers the last duplicate fm_session', () => {
    const a = 'eyJhbG.one'
    const b = 'eyJhbG.two'
    const raw = `other=1; fm_session=${a}; fm_session=${b}`
    expect(parseLastFmSessionValue(raw)).toBe(b)
  })
})

describe('sessionCookieSetOptions', () => {
  it('produces positive Max-Age and a future Expires (not 1970)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('COOKIE_DOMAIN', '.onetothree.ru')
    const { sessionCookieSetOptions } = await import('./session-cookie.js')
    const opts = sessionCookieSetOptions(60 * 60 * 24 * 7)
    const line = serialize('fm_session', 'x'.repeat(40), opts)
    expect(line).toMatch(/Max-Age=604800/)
    expect(line).not.toMatch(/Max-Age=0/)
    expect(line).not.toMatch(/Thu, 01 Jan 1970/)
    expect(line).toMatch(/Domain=\.onetothree\.ru/)
  })

  it('uses SameSite=Lax for insecure local HTTP so browsers keep the cookie', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('CORS_ALLOW_MOBILE_APP', '1')
    vi.stubEnv('COOKIE_SECURE', '0')
    const { sessionCookieSetOptions } = await import('./session-cookie.js')
    const opts = sessionCookieSetOptions(60)
    const line = serialize('fm_session', 'x'.repeat(40), opts)
    expect(line).toMatch(/SameSite=Lax/i)
    expect(line).not.toMatch(/;\s*Secure/i)
  })

  it('uses SameSite=None only when the cookie is Secure', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CORS_ALLOW_MOBILE_APP', '1')
    const { sessionCookieSetOptions } = await import('./session-cookie.js')
    const opts = sessionCookieSetOptions(60)
    const line = serialize('fm_session', 'x'.repeat(40), opts)
    expect(line).toMatch(/SameSite=None/i)
    expect(line).toMatch(/;\s*Secure/i)
  })

  it('rejects non-positive maxAge', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const { sessionCookieSetOptions } = await import('./session-cookie.js')
    expect(() => sessionCookieSetOptions(0)).toThrow(/maxAge/)
    expect(() => sessionCookieSetOptions(-1)).toThrow(/maxAge/)
  })
})
