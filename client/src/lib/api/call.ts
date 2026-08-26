import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'

export type CallConfig = {
  livekit_enabled: boolean
  livekit_url: string | null
  media_mode?: 'origin_safe' | 'self_hosted' | 'cloudflare'
  origin_safe?: boolean
  mesh_fallback_enabled?: boolean
  group_relay_enabled?: boolean
}

export type CallTokenResponse = {
  token: string
  url: string
  room: string
  ttl_seconds: number
  /** Base64-encoded 32-byte room E2EE key for LiveKit Insertable Streams. */
  call_e2ee_key?: string
}

export async function fetchCallConfig(): Promise<CallConfig> {
  const res = await fetchWithTimeout(`${API_URL}/call/config`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as Partial<CallConfig> & { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'CALL_CONFIG_FAILED')
  }
  return {
    livekit_enabled: Boolean(data.livekit_enabled),
    livekit_url: typeof data.livekit_url === 'string' ? data.livekit_url : null,
    media_mode:
      data.media_mode === 'origin_safe' || data.media_mode === 'self_hosted' || data.media_mode === 'cloudflare'
        ? data.media_mode
        : undefined,
    origin_safe: Boolean(data.origin_safe),
    mesh_fallback_enabled: Boolean(data.mesh_fallback_enabled),
    group_relay_enabled: Boolean(data.group_relay_enabled),
  }
}

export async function createCallToken(room: string): Promise<CallTokenResponse> {
  const res = await fetchWithTimeout(`${API_URL}/call/token`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room }),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<CallTokenResponse> & { error?: string }
  if (!res.ok || !data.token || !data.url) {
    throw new Error(data.error ?? 'CALL_TOKEN_FAILED')
  }
  return {
    token: data.token,
    url: data.url,
    room: typeof data.room === 'string' ? data.room : room,
    ttl_seconds: typeof data.ttl_seconds === 'number' ? data.ttl_seconds : 0,
    call_e2ee_key: typeof data.call_e2ee_key === 'string' ? data.call_e2ee_key : undefined,
  }
}

/**
 * Remove a MEMBER from a running call (#1). Distinct from
 * `kickGuestFromCall`: a link guest has no chat membership to reason about, so
 * the two go through different endpoints with different authority rules.
 *
 * Authority is the server's — chat admins and owners — and a refusal comes back
 * as `FORBIDDEN` so the UI can say "not allowed" rather than "try again".
 */
export async function removeCallParticipant(
  room: string,
  userId: string
): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/call/kick`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, user_id: userId }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'CALL_KICK_FAILED')
}
