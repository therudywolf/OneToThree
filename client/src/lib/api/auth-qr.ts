import { API_URL } from './auth'

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
