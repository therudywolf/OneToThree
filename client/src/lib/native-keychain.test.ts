import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
type FakeWindow = { __TAURI_INTERNALS__?: { invoke?: TauriInvoke } } | undefined

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
