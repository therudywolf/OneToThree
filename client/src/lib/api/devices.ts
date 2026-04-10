import { API_URL } from '@/lib/api/auth'
import { canonicalUserId } from '@/lib/user-id'

export type DeviceRow = {
  id: string
  device_name: string
  last_active: string
  user_agent: string | null
  ip_address: string | null
  revoked: boolean
  is_current: boolean
}

export async function fetchDevices(): Promise<{
  current_device_id: string | null
  devices: DeviceRow[]
}> {
  const res = await fetch(`${API_URL}/users/me/devices`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    current_device_id?: string | null
    devices?: DeviceRow[]
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'DEVICES_FETCH_FAILED')
  }
  return {
    current_device_id: data.current_device_id ?? null,
    devices: (data.devices ?? []).map((d) => ({
      ...d,
      id: canonicalUserId(d.id),
    })),
  }
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const res = await fetch(
    `${API_URL}/users/me/devices/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE', credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'DEVICE_REVOKE_FAILED')
  }
}
