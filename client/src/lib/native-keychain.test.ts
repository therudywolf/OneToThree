import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
type FakeCapacitor = {
  isNativePlatform?: () => boolean
  Plugins?: { Keystore?: Record<string, unknown> }
}
type FakeWindow =
  | { __TAURI_INTERNALS__?: { invoke?: TauriInvoke }; Capacitor?: FakeCapacitor }
  | undefined

const g = globalThis as unknown as { window: FakeWindow }
let prevWindow: FakeWindow

beforeEach(() => {
  prevWindow = g.window
})

afterEach(() => {
  g.window = prevWindow
  vi.resetModules()
})

async function importFresh() {
  vi.resetModules()
  return await import('./native-keychain')
}

describe('native-keychain — no window (Node/SSR)', () => {
  it('reports unavailable and returns null/false', async () => {
    g.window = undefined
    const m = await importFresh()
    expect(m.isKeychainAvailable()).toBe(false)
    expect(await m.keychainGet('slot')).toBeNull()
    expect(await m.keychainSet('slot', 'pin')).toBe(false)
    await expect(m.keychainDelete('slot')).resolves.toBeUndefined()
  })
})

describe('native-keychain — window present but no Tauri', () => {
  it('still reports unavailable', async () => {
    g.window = {}
    const m = await importFresh()
    expect(m.isKeychainAvailable()).toBe(false)
    expect(await m.keychainGet('slot')).toBeNull()
  })
})

describe('native-keychain — Tauri internals present', () => {
  it('routes to invoke and decodes string results', async () => {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'keychain_get' && args?.key === 'slot') return 'secret-pin'
      if (cmd === 'keychain_set') return undefined
      if (cmd === 'keychain_delete') return undefined
      throw new Error(`unexpected command ${cmd}`)
    })
    g.window = { __TAURI_INTERNALS__: { invoke } }
    const m = await importFresh()
    expect(m.isKeychainAvailable()).toBe(true)
    expect(await m.keychainGet('slot')).toBe('secret-pin')
    expect(await m.keychainSet('slot', 'pin')).toBe(true)
    await m.keychainDelete('slot')
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('swallows invoke errors', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('boom')
    })
    g.window = { __TAURI_INTERNALS__: { invoke } }
    const m = await importFresh()
    expect(await m.keychainGet('slot')).toBeNull()
    expect(await m.keychainSet('slot', 'pin')).toBe(false)
    await expect(m.keychainDelete('slot')).resolves.toBeUndefined()
  })
})

describe('secure-store — no native backend (web)', () => {
  it('reports unavailable and is a no-op', async () => {
    g.window = {}
    const m = await importFresh()
    expect(m.isNativeSecureStorageAvailable()).toBe(false)
    expect(await m.secureStoreGet('slot')).toBeNull()
    expect(await m.secureStoreSet('slot', 'pin')).toBe(false)
    await expect(m.secureStoreDelete('slot')).resolves.toBeUndefined()
  })
})

describe('secure-store — Capacitor Android Keystore plugin present', () => {
  function makeKeystore() {
    const store = new Map<string, string>()
    return {
      store,
      plugin: {
        get: vi.fn(async ({ key }: { key: string }) => ({
          value: store.has(key) ? store.get(key)! : null,
        })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
          store.set(key, value)
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
          store.delete(key)
        }),
      },
    }
  }

  it('routes secure-store get/set/remove through the plugin', async () => {
    const ks = makeKeystore()
    g.window = { Capacitor: { isNativePlatform: () => true, Plugins: { Keystore: ks.plugin } } }
    const m = await importFresh()

    expect(m.isNativeSecureStorageAvailable()).toBe(true)
    // Tauri path stays off when only Capacitor is present.
    expect(m.isKeychainAvailable()).toBe(false)

    expect(await m.secureStoreGet('vault-pin:u1')).toBeNull()
    expect(await m.secureStoreSet('vault-pin:u1', '1234')).toBe(true)
    expect(await m.secureStoreGet('vault-pin:u1')).toBe('1234')
    await m.secureStoreDelete('vault-pin:u1')
    expect(await m.secureStoreGet('vault-pin:u1')).toBeNull()
  })

  it('is unavailable when isNativePlatform() is false (web-in-browser)', async () => {
    const ks = makeKeystore()
    g.window = { Capacitor: { isNativePlatform: () => false, Plugins: { Keystore: ks.plugin } } }
    const m = await importFresh()
    expect(m.isNativeSecureStorageAvailable()).toBe(false)
    expect(await m.secureStoreGet('slot')).toBeNull()
    expect(await m.secureStoreSet('slot', 'pin')).toBe(false)
  })

  it('swallows plugin errors (falls back to prompt)', async () => {
    const plugin = {
      get: vi.fn(async () => {
        throw new Error('keystore boom')
      }),
      set: vi.fn(async () => {
        throw new Error('keystore boom')
      }),
      remove: vi.fn(async () => {
        throw new Error('keystore boom')
      }),
    }
    g.window = { Capacitor: { isNativePlatform: () => true, Plugins: { Keystore: plugin } } }
    const m = await importFresh()
    expect(await m.secureStoreGet('slot')).toBeNull()
    expect(await m.secureStoreSet('slot', 'pin')).toBe(false)
    await expect(m.secureStoreDelete('slot')).resolves.toBeUndefined()
  })
})

describe('secure-store — Tauri takes priority over Capacitor', () => {
  it('uses the Tauri keychain when both backends are present', async () => {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'keychain_get' && args?.key === 'slot') return 'tauri-pin'
      return undefined
    })
    const plugin = {
      get: vi.fn(async () => ({ value: 'capacitor-pin' })),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    }
    g.window = {
      __TAURI_INTERNALS__: { invoke },
      Capacitor: { isNativePlatform: () => true, Plugins: { Keystore: plugin } },
    }
    const m = await importFresh()
    expect(await m.secureStoreGet('slot')).toBe('tauri-pin')
    expect(plugin.get).not.toHaveBeenCalled()
  })
})
