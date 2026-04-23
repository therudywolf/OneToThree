type DevicePermissionsPlugin = {
  requestEssentialPermissions: () => Promise<{
    allGranted?: boolean
    states?: Record<string, 'granted' | 'denied'>
    missing?: string[]
  }>
  requestBackgroundExecution: () => Promise<{
    supported?: boolean
    requested?: boolean
    ignoringBatteryOptimizations?: boolean
  }>
}

function getDevicePermissionsPlugin(): DevicePermissionsPlugin | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean
      Plugins?: { DevicePermissions?: DevicePermissionsPlugin }
    }
  }
  if (!w.Capacitor?.isNativePlatform?.()) return null
  return w.Capacitor?.Plugins?.DevicePermissions ?? null
}

const ANDROID_PERMISSIONS_PROMPT_KEY = 'p13:android_permissions_prompted:v1'

export async function requestAndroidEssentialPermissionsOnce(): Promise<void> {
  if (typeof window === 'undefined') return
  const plugin = getDevicePermissionsPlugin()
  if (!plugin) return
  const alreadyPrompted = localStorage.getItem(ANDROID_PERMISSIONS_PROMPT_KEY)
  if (alreadyPrompted === '1') return

  try {
    await plugin.requestEssentialPermissions()
    await plugin.requestBackgroundExecution()
  } finally {
    localStorage.setItem(ANDROID_PERMISSIONS_PROMPT_KEY, '1')
  }
}

export async function requestAndroidEssentialPermissionsNow(): Promise<void> {
  const plugin = getDevicePermissionsPlugin()
  if (!plugin) return
  await plugin.requestEssentialPermissions()
  await plugin.requestBackgroundExecution()
}
