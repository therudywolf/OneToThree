import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isNativeCapacitorPlatform,
  resolveNativeSessionOrigins,
} from './native-session'

const originalWindow = globalThis.window

describe('native session bridge helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
      return
    }
    vi.stubGlobal('window', originalWindow)
  })

  it('detects native Capacitor shell only when bridge says so', () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://onetothree.ru' },
      Capacitor: {
        isNativePlatform: () => true,
      },
    })

    expect(isNativeCapacitorPlatform()).toBe(true)
  })

  it('resolves API and page origins without duplicates', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.onetothree.ru')
    vi.stubGlobal('window', {
      location: { origin: 'https://onetothree.ru' },
    })

    expect(resolveNativeSessionOrigins()).toEqual([
      'https://api.onetothree.ru',
      'https://onetothree.ru',
    ])
  })

  it('ignores non-http origins for native cookie sync', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'same-origin')
    vi.stubGlobal('window', {
      location: { origin: 'capacitor://localhost' },
    })

    expect(resolveNativeSessionOrigins()).toEqual([])
  })
})
