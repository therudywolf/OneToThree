import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'
import { authDeviceHeaders } from '@/lib/client-device'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'
import { warmNativeSessionCookies } from '@/lib/native-session'

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
  return `${base}/auth/qr?link_token=${encodeURIComponent(token)}`
}

export function extractQrLoginToken(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value
  }
  try {
    const parsed = new URL(value)
    const token = parsed.searchParams.get('link_token')?.trim() ?? ''
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      return token
    }
  } catch {
    // not a URL
  }
  return null
}

export async function postQrGenerate(params: {
  nonce: string
  signature: string
  totp_code?: string
}): Promise<{
  link_token: string
  expires_in: number
}> {
  const res = await fetchWithTimeout(`${API_URL}/auth/qr-generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
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
export async function postQrLogin(token: string): Promise<
  | { ok: true; user: { id: string; username: string } }
  | { ok: 'needs_2fa'; pendingToken: string; userId: string }
> {
  const res = await fetchWithTimeout(`${API_URL}/auth/qr-login`, {
    method: 'POST',
    credentials: 'include',
    headers: sanitizeFetchHeaderRecord({
      'Content-Type': 'application/json',
      ...authDeviceHeaders(),
    }),
    body: JSON.stringify({ link_token: token }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    user?: { id: string; username: string }
    requires2FA?: boolean
    pendingToken?: string
    userId?: string
    error?: string
  }
  if (
    res.ok &&
    data.requires2FA === true &&
    typeof data.pendingToken === 'string' &&
    typeof data.userId === 'string'
  ) {
    return {
      ok: 'needs_2fa',
      pendingToken: data.pendingToken,
      userId: data.userId,
    }
  }
  if (!res.ok || !data.user) {
    throw new Error(data.error ?? 'QR_LOGIN_FAILED')
  }
  await warmNativeSessionCookies()
  return { ok: true, user: data.user }
}
