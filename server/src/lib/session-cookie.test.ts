import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseLastFmSessionValue } from './session-cookie.js'
// Assert on the returned CookieSerializeOptions object directly rather than
// serializing with the `cookie` package: @fastify/cookie 11 pulls cookie 2.x,
// which renamed `serialize` → `stringifyCookie` with a different signature, so
// the old `serialize(name, value, opts)` no longer exists. The options object is
// the actual contract this function owns; serialization is fastify's job.

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
    expect(opts.maxAge).toBe(604800)
    expect(opts.expires).toBeInstanceOf(Date)
    expect((opts.expires as Date).getTime()).toBeGreaterThan(Date.now())
    expect(opts.domain).toBe('.onetothree.ru')
  })

  it('uses SameSite=Lax for insecure local HTTP so browsers keep the cookie', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('CORS_ALLOW_MOBILE_APP', '1')
    vi.stubEnv('COOKIE_SECURE', '0')
    const { sessionCookieSetOptions } = await import('./session-cookie.js')
    const opts = sessionCookieSetOptions(60)
    expect(String(opts.sameSite).toLowerCase()).toBe('lax')
    expect(opts.secure).toBeFalsy()
  })

  it('uses SameSite=None only when the cookie is Secure', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CORS_ALLOW_MOBILE_APP', '1')
    const { sessionCookieSetOptions } = await import('./session-cookie.js')
    const opts = sessionCookieSetOptions(60)
    expect(String(opts.sameSite).toLowerCase()).toBe('none')
    expect(opts.secure).toBe(true)
  })

  it('rejects non-positive maxAge', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const { sessionCookieSetOptions } = await import('./session-cookie.js')
    expect(() => sessionCookieSetOptions(0)).toThrow(/maxAge/)
    expect(() => sessionCookieSetOptions(-1)).toThrow(/maxAge/)
  })
})
