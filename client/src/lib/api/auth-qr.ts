import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'
import { authDeviceHeaders } from '@/lib/client-device'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'
import { warmNativeSessionCookies } from '@/lib/native-session'
import {
  parseVaultBlobJson,
  persistVaultBlob,
  persistVaultBlobByLoginUsername,
  readVaultBlob,
  readVaultBlobByLoginUsername,
} from '@/lib/vault'

const DEFAULT_PUBLIC_APP_ORIGIN = 'https://onetothree.ru'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type QrLoginUser = { id: string; username: string }
export type QrVaultHandoffStatus = 'existing' | 'restored' | 'missing' | 'invalid'

function normalizeHttpOrigin(raw: string | undefined | null): string | null {
  const value = raw?.trim().replace(/\/+$/, '')
  if (!value || value === 'same-origin') return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin
    }
  } catch {
    return null
  }
  return null
}

function isNativeLocalOrigin(origin: string): boolean {
  return (
    origin === 'capacitor://localhost' ||
    origin === 'http://localhost' ||
    origin === 'https://localhost'
  )
}

export function resolveQrLoginOrigin(): string {
  const configured = normalizeHttpOrigin(
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_APP_URL : undefined
  )
  if (configured) return configured

  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin
    if (isNativeLocalOrigin(origin)) return DEFAULT_PUBLIC_APP_ORIGIN
    const normalized = normalizeHttpOrigin(origin)
    if (normalized) return normalized
  }

  return DEFAULT_PUBLIC_APP_ORIGIN
}

export function buildQrLoginUrl(token: string): string {
  const base = resolveQrLoginOrigin()
  return `${base}/auth/qr?link_token=${encodeURIComponent(token)}`
}

function validUuid(value: string | null | undefined): string | null {
  const token = value?.trim() ?? ''
  return UUID_PATTERN.test(token) ? token : null
}

export function extractQrLoginToken(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const direct = validUuid(value)
  if (direct) return direct
  try {
    const parsed = new URL(value)
    const queryToken =
      validUuid(parsed.searchParams.get('link_token')) ??
      validUuid(parsed.searchParams.get('token'))
    if (queryToken) return queryToken

    const pathToken = validUuid(parsed.pathname.split('/').filter(Boolean).pop())
    if (pathToken) return pathToken
  } catch {
    // not a URL
  }
  return null
}

export function hasLocalVaultForQrUser(user: QrLoginUser): boolean {
  return Boolean(readVaultBlob(user.id) ?? readVaultBlobByLoginUsername(user.username))
}

export function persistQrVaultHandoff(
  user: QrLoginUser,
  vaultBlobRaw?: string
): QrVaultHandoffStatus {
  if (typeof window === 'undefined') return vaultBlobRaw?.trim() ? 'invalid' : 'missing'

  const raw = vaultBlobRaw?.trim()
  if (raw) {
    const parsed = parseVaultBlobJson(raw)
    if (!parsed) return 'invalid'

    persistVaultBlob(user.id, parsed)
    persistVaultBlobByLoginUsername(user.username, parsed)
    return 'restored'
  }

  const existing = readVaultBlob(user.id) ?? readVaultBlobByLoginUsername(user.username)
  if (existing) {
    persistVaultBlob(user.id, existing)
    persistVaultBlobByLoginUsername(user.username, existing)
    return 'existing'
  }

  return 'missing'
}

export async function postQrGenerate(params: {
  nonce: string
  signature: string
  totp_code?: string
  vault_blob?: string
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
  | {
      ok: true
      user: { id: string; username: string }
      vaultHandoff: QrVaultHandoffStatus
    }
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
    vault_blob?: string
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
  return {
    ok: true,
    user: data.user,
    vaultHandoff: persistQrVaultHandoff(data.user, data.vault_blob),
  }
}
