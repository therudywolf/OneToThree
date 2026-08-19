// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setNativeFlagSecure } from './native-flag-secure'

/**
 * FLAG_SECURE is what stops screenshots, screen recording and the recent-apps
 * thumbnail from capturing decrypted chats. MainActivity turns it on at
 * startup; this bridge is how the user's privacy toggle turns it back off and
 * on again. A silent no-op here leaves the window in whatever state it was —
 * which, for the "off" direction, means a setting the UI reports as applied and
 * is not.
 */

function installPrivacy(setSecure?: unknown, native = true) {
  ;(window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => native,
    Plugins: setSecure === undefined ? {} : { Privacy: { setSecure } },
  }
}

describe('native FLAG_SECURE bridge', () => {
  beforeEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor
  })

  it('passes the flag through to the native plugin', async () => {
    const setSecure = vi.fn().mockResolvedValue(undefined)
    installPrivacy(setSecure)

    await setNativeFlagSecure(true)
    await setNativeFlagSecure(false)

    expect(setSecure).toHaveBeenNthCalledWith(1, { secure: true })
    expect(setSecure).toHaveBeenNthCalledWith(2, { secure: false })
  })

  it('does nothing on web, where there is no Capacitor', async () => {
    await expect(setNativeFlagSecure(true)).resolves.toBeUndefined()
  })

  /**
   * A browser tab that somehow carries a Capacitor shim must not be treated as
   * a device: isNativePlatform() is the gate.
   */
  it('does not call the plugin when the platform is not native', async () => {
    const setSecure = vi.fn()
    installPrivacy(setSecure, false)
    await setNativeFlagSecure(true)
    expect(setSecure).not.toHaveBeenCalled()
  })

  /** The plugin name and method must match PrivacyPlugin's @PluginMethod. */
  it('is inert when the plugin exists but has no setSecure', async () => {
    installPrivacy(null)
    await expect(setNativeFlagSecure(true)).resolves.toBeUndefined()
  })

  it('a rejecting plugin call is contained, not thrown at the caller', async () => {
    installPrivacy(vi.fn().mockRejectedValue(new Error('window already destroyed')))
    await expect(setNativeFlagSecure(true)).resolves.toBeUndefined()
  })

  it('a plugin that throws synchronously is contained too', async () => {
    installPrivacy(
      vi.fn(() => {
        throw new Error('bridge died')
      })
    )
    await expect(setNativeFlagSecure(false)).resolves.toBeUndefined()
  })
})
