import { serialize } from 'cookie'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
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

  it('rejects non-positive maxAge', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const { sessionCookieSetOptions } = await import('./session-cookie.js')
    expect(() => sessionCookieSetOptions(0)).toThrow(/maxAge/)
    expect(() => sessionCookieSetOptions(-1)).toThrow(/maxAge/)
  })
})
