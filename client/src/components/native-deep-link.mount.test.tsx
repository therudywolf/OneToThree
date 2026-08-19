// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { NativeDeepLink } from './native-deep-link'

/**
 * The listener wiring, exercised where it actually broke: mounting the
 * component against the plugin shape a device provides.
 *
 * Capacitor's Android runtime generates `Plugins.App.addListener` itself
 * (JSExport), and it returns a PLAIN `{ remove }` — not a Promise. The old code
 * called `.then()` on it, so the effect threw `TypeError` on every launch of the
 * APK. `<NativeDeepLink />` sits OUTSIDE the ErrorBoundary in app/layout.tsx, so
 * that throw unmounted the entire app. No browser test could see it: on the web
 * the plugin is absent and the effect returns early.
 */

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

type Listener = (data: { url?: string }) => void

/** The natively injected shape: addListener returns a plain object. */
function installNativeApp(launchUrl?: string) {
  const listeners: Listener[] = []
  const remove = vi.fn()
  ;(window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        addListener: (_event: string, fn: Listener) => {
          listeners.push(fn)
          return { remove } // ← no .then here, and that is the point
        },
        getLaunchUrl: () => Promise.resolve(launchUrl ? { url: launchUrl } : null),
      },
    },
  }
  return { listeners, remove }
}

/** Let the listener-attach promise settle before asserting on it. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('<NativeDeepLink /> against the real device plugin shape', () => {
  beforeEach(() => {
    push.mockClear()
    delete (window as unknown as { Capacitor?: unknown }).Capacitor
  })
  afterEach(cleanup)

  it('mounts without throwing and registers the listener', () => {
    const { listeners } = installNativeApp()
    expect(() => render(<NativeDeepLink />)).not.toThrow()
    expect(listeners).toHaveLength(1)
  })

  it('routes a link tapped while the app is running', async () => {
    const { listeners } = installNativeApp()
    render(<NativeDeepLink />)
    await flush()

    listeners[0]?.({ url: 'https://onetothree.ru/join/INVITE9' })
    expect(push).toHaveBeenCalledWith('/join/_?code=INVITE9')
  })

  it('routes the cold-start launch URL', async () => {
    installNativeApp('onetothree://chat?code=COLD1')
    render(<NativeDeepLink />)
    await flush()
    expect(push).toHaveBeenCalledWith('/join/_?code=COLD1')
  })

  it('removes the listener on unmount', async () => {
    const { remove } = installNativeApp()
    const view = render(<NativeDeepLink />)
    await flush()
    view.unmount()
    expect(remove).toHaveBeenCalled()
  })

  it('is inert on the web, where there is no Capacitor', () => {
    expect(() => render(<NativeDeepLink />)).not.toThrow()
    expect(push).not.toHaveBeenCalled()
  })

  it('survives a plugin whose addListener throws', () => {
    ;(window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        App: {
          addListener: () => {
            throw new Error('bridge not ready')
          },
        },
      },
    }
    expect(() => render(<NativeDeepLink />)).not.toThrow()
  })
})
