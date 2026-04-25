import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildQrLoginUrl,
  extractQrLoginToken,
  persistQrVaultHandoff,
  resolveQrLoginOrigin,
} from './auth-qr'
import { readVaultBlob, readVaultBlobByLoginUsername } from '@/lib/vault'

const TOKEN = '00000000-0000-4000-8000-000000000001'
const VAULT_BLOB = JSON.stringify({
  version: 5,
  saltB64: 'salt',
  ivB64: 'iv',
  ciphertextB64: 'cipher',
})

function stubWindow(origin: string) {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }

  vi.stubGlobal('window', {
    location: { origin },
    localStorage,
  })
  vi.stubGlobal('localStorage', localStorage)
}

describe('auth QR helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('uses explicit public app URL for QR links', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://onetothree.ru/')
    stubWindow('https://localhost')

    expect(resolveQrLoginOrigin()).toBe('https://onetothree.ru')
    expect(buildQrLoginUrl(TOKEN)).toBe(
      `https://onetothree.ru/auth/qr?link_token=${TOKEN}`
    )
  })

  it('does not export native localhost origins into scannable QR links', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    stubWindow('https://localhost')

    expect(buildQrLoginUrl(TOKEN)).toBe(
      `https://onetothree.ru/auth/qr?link_token=${TOKEN}`
    )
  })

  it('extracts QR token from raw UUID, query, and URL path', () => {
    expect(extractQrLoginToken(TOKEN)).toBe(TOKEN)
    expect(extractQrLoginToken(`https://onetothree.ru/auth/qr?link_token=${TOKEN}`)).toBe(TOKEN)
    expect(extractQrLoginToken(`https://onetothree.ru/auth/qr?token=${TOKEN}`)).toBe(TOKEN)
    expect(extractQrLoginToken(`https://onetothree.ru/auth/qr/${TOKEN}`)).toBe(TOKEN)
    expect(extractQrLoginToken('https://onetothree.ru/auth/qr?link_token=bad')).toBeNull()
  })

  it('persists encrypted vault handoff by user id and username', () => {
    stubWindow('https://onetothree.ru')

    const status = persistQrVaultHandoff(
      { id: 'user-1', username: 'alice' },
      VAULT_BLOB
    )

    expect(status).toBe('restored')
    expect(readVaultBlob('user-1')?.ciphertextB64).toBe('cipher')
    expect(readVaultBlobByLoginUsername('alice')?.ciphertextB64).toBe('cipher')
  })
})
