import { API_URL } from './auth'
import { authDeviceHeaders } from '@/lib/client-device'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'

export async function postQrGenerate(): Promise<{
  link_token: string
  expires_in: number
}> {
  const res = await fetch(`${API_URL}/auth/qr-generate`, {
    method: 'POST',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    link_token?: string
    expires_in?: number
    error?: string
  }
  if (!res.ok || !data.link_token) {
    throw new Error(data.error ?? 'QR_GENERATE_FAILED')
  }
  return {
    link_token: data.link_token,
    expires_in: data.expires_in ?? 300,
  }
}

/** New device: redeem QR token → session cookie (requires X-Client-Device-Id). */
export async function postQrLogin(token: string): Promise<{
  ok: boolean
  user: { id: string; username: string }
}> {
  const res = await fetch(`${API_URL}/auth/qr-login`, {
    method: 'POST',
    credentials: 'include',
    headers: sanitizeFetchHeaderRecord({
      'Content-Type': 'application/json',
      ...authDeviceHeaders(),
    }),
    body: JSON.stringify({ token }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    user?: { id: string; username: string }
    error?: string
  }
  if (res.status === 501) {
    throw new Error(data.error ?? 'QR_LOGIN_REQUIRES_TOTP_STUB')
  }
  if (!res.ok || !data.user) {
    throw new Error(data.error ?? 'QR_LOGIN_FAILED')
  }
  return { ok: true, user: data.user }
}
