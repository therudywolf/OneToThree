import { API_URL } from './auth'

export async function patchMyEcdhPublicKey(
  ecdh_public_key_jwk: string
): Promise<void> {
  const res = await fetch(`${API_URL}/users/me`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ecdh_public_key_jwk }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'PATCH_ECDH_FAILED')
  }
}
