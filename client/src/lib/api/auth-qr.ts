import { API_URL } from './auth'
import { authDeviceHeaders } from '@/lib/client-device'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'

function browserOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  const apiRoot = API_URL.replace(/\/api$/, '')
  if (apiRoot.startsWith('http://') || apiRoot.startsWith('https://')) {
    return apiRoot
  }
  return ''
}

export function buildQrLoginUrl(token: string): string {
  const base = browserOrigin()
  if (!base) return token
  return `${base}/auth/qr?token=${encodeURIComponent(token)}`
}

export function extractQrLoginToken(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value
  }
  try {
    const parsed = new URL(value)
    const token = parsed.searchParams.get('token')?.trim() ?? ''
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      return token
    }
  } catch {
    // not a URL
  }
  return null
}

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
