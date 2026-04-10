const STORAGE_KEY = 'fm_client_device_id'

function randomId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `dev_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

/** Stable per-browser profile; sent as X-Client-Device-Id for device rows + JWT device_id. */
export function getOrCreateClientDeviceId(): string {
  if (typeof window === 'undefined') return randomId()
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)?.trim()
    if (existing && existing.length >= 4) return existing
    const id = randomId()
    window.localStorage.setItem(STORAGE_KEY, id)
    return id
  } catch {
    return randomId()
  }
}

/** Short label for X-Device-Name (server truncates). */
export function getDeviceDisplayLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown'
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''
  const short = ua.length > 80 ? `${ua.slice(0, 77)}…` : ua
  return `${platform} · ${short}`
}

export function authDeviceHeaders(): Record<string, string> {
  return {
    'X-Client-Device-Id': getOrCreateClientDeviceId(),
    'X-Device-Name': getDeviceDisplayLabel(),
  }
}
