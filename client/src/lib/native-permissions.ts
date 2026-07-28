type EssentialPermissionsResult = {
  allGranted?: boolean
  states?: Record<string, 'granted' | 'denied'>
  missing?: string[]
}

type DevicePermissionsPlugin = {
  requestEssentialPermissions: () => Promise<EssentialPermissionsResult>
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
/** Last known {allGranted, missing} from a completed request, for the UI. */
const ANDROID_PERMISSIONS_STATE_KEY = 'p13:android_permissions_state:v1'
/**
 * The prompt used to be marked "done" in a `finally`, so a request that never
 * completed (user backgrounded the app, bridge call rejected) burned the single
 * shot the app ever takes — after that every call failed getUserMedia with no
 * way back. Retry on later launches while something essential is still missing.
 * Android itself stops showing the dialog after the user hard-denies, so a small
 * cap is enough to avoid pestering.
 */
const MAX_PROMPT_ATTEMPTS = 3

function readAttempts(): number {
  const raw = localStorage.getItem(ANDROID_PERMISSIONS_PROMPT_KEY)
  if (raw === null) return 0
  // '1' is the legacy one-shot marker written by the old implementation.
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function rememberResult(result: EssentialPermissionsResult | null): void {
  if (!result) return
  try {
    localStorage.setItem(
      ANDROID_PERMISSIONS_STATE_KEY,
      JSON.stringify({
        allGranted: result.allGranted === true,
        missing: Array.isArray(result.missing) ? result.missing : [],
        ts: new Date().toISOString(),
      })
    )
  } catch {
    /* ignore storage failures */
  }
}

/**
 * Aliases still not granted as of the last completed request. `null` means we
 * have never recorded a result (never asked, or asked by the old build that
 * stored nothing) — that is NOT the same as "all granted".
 */
export function getMissingAndroidPermissions(): string[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(ANDROID_PERMISSIONS_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { missing?: unknown }
    return Array.isArray(parsed.missing) ? (parsed.missing as string[]) : null
  } catch {
    return null
  }
}

export async function requestAndroidEssentialPermissionsOnce(): Promise<void> {
  if (typeof window === 'undefined') return
  const plugin = getDevicePermissionsPlugin()
  if (!plugin) return
  const attempts = readAttempts()
  if (attempts >= MAX_PROMPT_ATTEMPTS) return
  // Everything already granted last time — nothing to prompt for.
  if (getMissingAndroidPermissions()?.length === 0) return

  const result = await requestAndroidEssentialPermissionsNow()
  // Only count an attempt that actually came back; a rejected/aborted request
  // must not consume one.
  if (result) {
    try {
      localStorage.setItem(ANDROID_PERMISSIONS_PROMPT_KEY, String(attempts + 1))
    } catch {
      /* ignore storage failures */
    }
  }
}

/**
 * Re-request the essential permissions on demand (e.g. from a "grant access"
 * action on the media-error banner). Returns null if the request did not
 * complete, so the caller can tell "denied" from "never asked".
 */
export async function requestAndroidEssentialPermissionsNow(): Promise<EssentialPermissionsResult | null> {
  const plugin = getDevicePermissionsPlugin()
  if (!plugin) return null
  let result: EssentialPermissionsResult
  try {
    result = await plugin.requestEssentialPermissions()
  } catch {
    return null
  }
  rememberResult(result)
  // Battery-optimisation exemption is a separate, non-blocking ask.
  try {
    await plugin.requestBackgroundExecution()
  } catch {
    /* best-effort — a denied exemption must not fail the permission flow */
  }
  return result
}
