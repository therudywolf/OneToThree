import { describe, expect, it } from 'vitest'
import { resolveWebAuthnRp } from './passkey-rp.js'

describe('resolveWebAuthnRp', () => {
  it('derives the RP ID from the first https CORS origin', () => {
    const rp = resolveWebAuthnRp({ CORS_ORIGIN: 'https://onetothree.ru' })
    expect(rp).toEqual({ rpID: 'onetothree.ru', rpName: 'OneToThree', origins: ['https://onetothree.ru'] })
  })

  it('keeps subdomain origins that sit under the RP ID and drops the rest', () => {
    const rp = resolveWebAuthnRp({
      CORS_ORIGIN: 'https://onetothree.ru, https://app.onetothree.ru, https://other.example',
    })
    expect(rp?.origins).toEqual(['https://onetothree.ru', 'https://app.onetothree.ru'])
  })

  it('ignores the WebView origins a mobile CORS list carries', () => {
    const rp = resolveWebAuthnRp({
      CORS_ORIGIN: 'https://onetothree.ru,https://localhost,capacitor://localhost,tauri://localhost',
    })
    expect(rp?.origins).toEqual(['https://onetothree.ru'])
  })

  it('tolerates a trailing comment on the env line', () => {
    const rp = resolveWebAuthnRp({ CORS_ORIGIN: 'https://onetothree.ru       # авто-заполняется' })
    expect(rp?.rpID).toBe('onetothree.ru')
  })

  it('honours an explicit WEBAUTHN_RP_ID and refuses origins outside it', () => {
    const rp = resolveWebAuthnRp({
      CORS_ORIGIN: 'https://chat.example.org,https://example.org',
      WEBAUTHN_RP_ID: 'example.org',
    })
    expect(rp?.rpID).toBe('example.org')
    expect(rp?.origins).toEqual(['https://chat.example.org', 'https://example.org'])
    expect(resolveWebAuthnRp({ CORS_ORIGIN: 'https://chat.example.org', WEBAUTHN_RP_ID: 'other.test' })).toBeNull()
  })

  it('allows plain-http localhost for a dev stack, and nothing else over http', () => {
    expect(resolveWebAuthnRp({ CORS_ORIGIN: 'http://localhost:3000' })?.rpID).toBe('localhost')
    expect(resolveWebAuthnRp({ CORS_ORIGIN: 'http://insecure.example' })).toBeNull()
  })

  it('returns null when nothing usable is configured', () => {
    expect(resolveWebAuthnRp({})).toBeNull()
    expect(resolveWebAuthnRp({ CORS_ORIGIN: '*' })).toBeNull()
  })
})
