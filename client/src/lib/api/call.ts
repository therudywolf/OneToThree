import { API_URL } from './auth'

export type CallConfig = {
  livekit_enabled: boolean
  livekit_url: string | null
}

export type CallTokenResponse = {
  token: string
  url: string
  room: string
  ttl_seconds: number
}

export async function fetchCallConfig(): Promise<CallConfig> {
  const res = await fetch(`${API_URL}/call/config`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as Partial<CallConfig> & { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'CALL_CONFIG_FAILED')
  }
  return {
    livekit_enabled: Boolean(data.livekit_enabled),
    livekit_url: typeof data.livekit_url === 'string' ? data.livekit_url : null,
  }
}

export async function createCallToken(room: string): Promise<CallTokenResponse> {
  const res = await fetch(`${API_URL}/call/token`, {
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
  }
}
