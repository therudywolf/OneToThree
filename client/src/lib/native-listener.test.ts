// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { attachNativeListener } from './native-listener'

/**
 * The APK gets a different `addListener` than the types promise.
 *
 * Capacitor's Android runtime generates the plugin objects itself
 * (JSExport.getPluginJS): `t.addListener = function (e, cb) { return
 * w.Capacitor.addListener(id, e, cb) }`, and that returns a PLAIN `{ remove }`
 * — not a Promise. This client never bundles @capacitor/core, so the injected
 * shape is the only one it ever sees on a device.
 *
 * Calling `.then()` on it threw a TypeError inside a useEffect. For the
 * deep-link handler — mounted outside the ErrorBoundary — that took the whole
 * app down on launch; for the push handler it rendered the error screen. Both
 * on every start of the APK, and neither reproducible in any browser, which is
 * where every existing test runs.
 */
describe('attachNativeListener', () => {
  it('accepts the plain handle the native bridge returns', async () => {
    const remove = vi.fn()
    const detach = await attachNativeListener(() => ({ remove }))
    expect(detach).toBeTypeOf('function')
    detach?.()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('accepts the promised handle the npm package returns', async () => {
    const remove = vi.fn()
    const detach = await attachNativeListener(() => Promise.resolve({ remove }))
    expect(detach).toBeTypeOf('function')
    detach?.()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  /** The injected bridge's `remove` is async; awaiting it is not the caller's job. */
  it('tolerates an async remove', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const detach = await attachNativeListener(() => ({ remove }))
    expect(() => detach?.()).not.toThrow()
    expect(remove).toHaveBeenCalled()
  })

  it('contains a remove that rejects', async () => {
    const detach = await attachNativeListener(() => ({
      remove: vi.fn().mockRejectedValue(new Error('listener already gone')),
    }))
    expect(() => detach?.()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('contains a remove that throws synchronously', async () => {
    const detach = await attachNativeListener(() => ({
      remove: () => {
        throw new Error('bridge died')
      },
    }))
    expect(() => detach?.()).not.toThrow()
  })

  it('returns null when registration throws', async () => {
    expect(
      await attachNativeListener(() => {
        throw new Error('no such plugin')
      })
    ).toBeNull()
  })

  it('returns null when registration rejects', async () => {
    expect(await attachNativeListener(() => Promise.reject(new Error('denied')))).toBeNull()
  })

  it('returns null for a handle with nothing to remove', async () => {
    expect(await attachNativeListener(() => ({}))).toBeNull()
    expect(await attachNativeListener(() => null)).toBeNull()
    expect(await attachNativeListener(() => undefined)).toBeNull()
  })
})
