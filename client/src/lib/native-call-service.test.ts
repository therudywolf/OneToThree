// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { startCallForegroundService, stopCallForegroundService } from './native-call-service'

/**
 * This bridge is the only thing keeping a backgrounded call's microphone alive
 * on Android 12+ (issue #3/#13). Every failure mode here is silent: the plugin
 * is looked up by string name, both calls swallow rejections, and the whole
 * module is a no-op on web — so a rename, a throw, or an early return does not
 * surface anywhere except as "the other side stops hearing me".
 */

type Calls = { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }

function installPlugin(over: Partial<Calls> = {}): Calls {
  const plugin: Calls = {
    start: over.start ?? vi.fn().mockResolvedValue({ ok: true }),
    stop: over.stop ?? vi.fn().mockResolvedValue({ ok: true }),
  }
  ;(window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { CallService: plugin },
  }
  return plugin
}

describe('call foreground service bridge', () => {
  beforeEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor
  })

  it('starts and stops the native service when the plugin is there', () => {
    const plugin = installPlugin()
    startCallForegroundService()
    stopCallForegroundService()
    expect(plugin.start).toHaveBeenCalledTimes(1)
    expect(plugin.stop).toHaveBeenCalledTimes(1)
  })

  /**
   * The service is typed at start, and a microphone-typed one keeps the mic
   * alive in the background and nothing else — a backgrounded video call went
   * on being heard and stopped being seen. The native side can't tell whether a
   * camera track is live, so this flag is the only signal it gets.
   */
  it('tells the native side whether the camera is live', () => {
    const plugin = installPlugin()
    startCallForegroundService(true)
    expect(plugin.start).toHaveBeenCalledWith({ video: true })
  })

  it('defaults to audio-only, so an audio call never claims the camera type', () => {
    const plugin = installPlugin()
    startCallForegroundService()
    expect(plugin.start).toHaveBeenCalledWith({ video: false })
  })

  /** A web build has no Capacitor at all; calling must not throw. */
  it('is a no-op with no Capacitor present', () => {
    expect(() => {
      startCallForegroundService()
      stopCallForegroundService()
    }).not.toThrow()
  })

  /**
   * The plugin is resolved by the string "CallService", which must match
   * @CapacitorPlugin(name = "CallService") on the Java side. If either is
   * renamed the lookup yields undefined — no error, just no foreground service.
   */
  it('looks the plugin up under the exact name the native side registers', () => {
    const plugin = { start: vi.fn(), stop: vi.fn() }
    ;(window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CallForegroundService: plugin }, // wrong name on purpose
    }
    expect(() => startCallForegroundService()).not.toThrow()
    expect(plugin.start).not.toHaveBeenCalled()
  })

  /**
   * Android throws ForegroundServiceStartNotAllowedException when the app is
   * already in the background. That rejection must not escape as an unhandled
   * promise — a call in progress is exactly when a crash is least acceptable.
   */
  it('swallows a rejected start without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    installPlugin({ start: vi.fn().mockRejectedValue(new Error('FGS not allowed')) })

    startCallForegroundService()
    await new Promise((r) => setTimeout(r, 0))

    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('swallows a rejected stop as well', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    installPlugin({ stop: vi.fn().mockRejectedValue(new Error('service already gone')) })

    stopCallForegroundService()
    await new Promise((r) => setTimeout(r, 0))

    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })

  /** Hanging up twice, or a stop racing a failed start, must stay harmless. */
  it('tolerates being stopped without ever being started', () => {
    const plugin = installPlugin()
    stopCallForegroundService()
    stopCallForegroundService()
    expect(plugin.stop).toHaveBeenCalledTimes(2)
    expect(plugin.start).not.toHaveBeenCalled()
  })
})
