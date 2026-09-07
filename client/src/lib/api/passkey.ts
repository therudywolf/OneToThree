import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'

/**
 * Passkey-sealed keyring endpoints (server/src/routes/passkey.ts).
 * The server only ever sees ciphertext; see lib/passkey-keyring.ts.
 */

export type PasskeyRow = {
  id: string
  label: string | null
  aaguid: string | null
  transports: string[]
  created_at: string
  last_used_at: string | null
}

async function readJson<T>(res: Response, fallbackError: string): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? fallbackError)
  return data
}

export async function listPasskeys(): Promise<{ available: boolean; passkeys: PasskeyRow[] }> {
  const res = await fetchWithTimeout(`${API_URL}/auth/passkey`, { credentials: 'include' })
  return readJson(res, 'PASSKEY_LIST_FAILED')
}

export async function passkeyRegisterOptions(): Promise<{
  options: PublicKeyCredentialCreationOptionsJSON
}> {
  const res = await fetchWithTimeout(`${API_URL}/auth/passkey/register/options`, {
    method: 'POST',
    credentials: 'include',
  })
  return readJson(res, 'PASSKEY_OPTIONS_FAILED')
}

export type PasskeyRegisterVerifyBody = {
  response: unknown
  label?: string
  prf_salt: string
  hkdf_salt: string
  wrap_iv: string
  wrapped_keyring: string
}

export async function passkeyRegisterVerify(body: PasskeyRegisterVerifyBody): Promise<{ id: string }> {
  const res = await fetchWithTimeout(`${API_URL}/auth/passkey/register/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  return readJson(res, 'PASSKEY_REGISTER_FAILED')
}

export async function deletePasskey(id: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/auth/passkey/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await readJson(res, 'PASSKEY_DELETE_FAILED')
}

export async function passkeyLoginOptions(username: string): Promise<{
  options: PublicKeyCredentialRequestOptionsJSON
  prf_salts: Record<string, string>
}> {
  const res = await fetchWithTimeout(`${API_URL}/auth/passkey/login/options`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ username: username.trim() }),
  })
  return readJson(res, 'PASSKEY_OPTIONS_FAILED')
}

export async function passkeyLoginVerify(
  username: string,
  response: unknown,
): Promise<{ hkdf_salt: string; wrap_iv: string; wrapped_keyring: string }> {
  const res = await fetchWithTimeout(`${API_URL}/auth/passkey/login/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ username: username.trim(), response }),
  })
  return readJson(res, 'PASSKEY_ASSERTION_INVALID')
}

// Minimal JSON shapes (WebAuthn Level 3 *JSON types) — kept local so the
// client does not depend on lib.dom versions that may not ship them yet.
export type PublicKeyCredentialCreationOptionsJSON = {
  rp: { id?: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: { type: 'public-key'; alg: number }[]
  timeout?: number
  excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[]
  authenticatorSelection?: AuthenticatorSelectionCriteria
  attestation?: AttestationConveyancePreference
  extensions?: Record<string, unknown>
}

export type PublicKeyCredentialRequestOptionsJSON = {
  challenge: string
  timeout?: number
  rpId?: string
  allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[]
  userVerification?: UserVerificationRequirement
  extensions?: Record<string, unknown>
}
