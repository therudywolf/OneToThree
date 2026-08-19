// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  requestAndroidEssentialPermissionsOnce,
  requestAndroidEssentialPermissionsNow,
  getMissingAndroidPermissions,
} from './native-permissions'

type Result = { allGranted?: boolean; missing?: string[] }

function installPlugin(requestEssentialPermissions: () => Promise<Result>) {
  const requestBackgroundExecution = vi.fn().mockResolvedValue({ supported: true })
  ;(window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      DevicePermissions: { requestEssentialPermissions, requestBackgroundExecution },
    },
  }
  return { requestBackgroundExecution }
}

describe('requestAndroidEssentialPermissionsOnce', () => {
  beforeEach(() => {
    localStorage.clear()
    delete (window as unknown as { Capacitor?: unknown }).Capacitor
  })

  it('does not burn a prompt attempt when the request never completes', async () => {
    const request = vi.fn().mockRejectedValue(new Error('activity destroyed'))
    installPlugin(request)

    // The old implementation set the "prompted" flag in a finally block, so a
    // request that never came back still consumed an attempt and the user ran
    // out of prompts without ever seeing a dialog.
    //
    // This has to run past the attempt cap (3) to mean anything: with the bug,
    // the first three calls each burn an attempt and every later call is a
    // silent no-op. Two calls would pass either way — which is exactly what
    // this test used to do.
    for (let i = 0; i < 5; i++) await requestAndroidEssentialPermissionsOnce()

    expect(request).toHaveBeenCalledTimes(5)
  })

  it('stops asking once everything is granted', async () => {
    const request = vi.fn().mockResolvedValue({ allGranted: true, missing: [] })
    installPlugin(request)

    await requestAndroidEssentialPermissionsOnce()
    await requestAndroidEssentialPermissionsOnce()

    expect(request).toHaveBeenCalledTimes(1)
    expect(getMissingAndroidPermissions()).toEqual([])
  })

  it('retries after a denial but stops at the attempt cap', async () => {
    const request = vi.fn().mockResolvedValue({ allGranted: false, missing: ['microphone'] })
    installPlugin(request)

    for (let i = 0; i < 5; i++) await requestAndroidEssentialPermissionsOnce()

    expect(request).toHaveBeenCalledTimes(3)
    expect(getMissingAndroidPermissions()).toEqual(['microphone'])
  })

  it('exposes the outstanding permissions after an explicit re-request', async () => {
    const request = vi.fn().mockResolvedValue({ allGranted: false, missing: ['camera'] })
    const { requestBackgroundExecution } = installPlugin(request)

    const result = await requestAndroidEssentialPermissionsNow()

    expect(result).toEqual({ allGranted: false, missing: ['camera'] })
    expect(requestBackgroundExecution).toHaveBeenCalledTimes(1)
    expect(getMissingAndroidPermissions()).toEqual(['camera'])
  })
})
