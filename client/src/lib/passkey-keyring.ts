/**
 * The account key as an "electronic token": a passkey with the WebAuthn PRF
 * extension (1Password, Bitwarden, iCloud Keychain, Google Password Manager,
 * a YubiKey 5 / any FIDO2 key with hmac-secret).
 *
 * How it works
 *   enrol   local vault ──password──▸ keyring plaintext
 *           passkey.create + PRF(salt) ─▸ 32-byte secret only this credential
 *           can reproduce, only on this RP, only after user verification
 *           HKDF(secret, hkdfSalt) ─▸ AES-256-GCM key ─▸ seal(plaintext)
 *           ciphertext + credential public key ─▸ server (routes/passkey.ts)
 *
 *   unlock  passkey.get + PRF(salt) ─▸ same secret ─▸ same key
 *           server verifies the assertion, releases ciphertext ─▸ unseal
 *           ─▸ keyring plaintext ─▸ re-wrap with the user's password into a
 *           normal local vault ─▸ the usual ECDSA sign-in
 *
 * What the server sees: ciphertext, salts, a public key. Never the PRF secret,
 * the keyring, or a password. What the passkey holder gets: a way to bring the
 * key to a new device with nothing to copy. Losing the passkey loses this copy
 * only.
 *
 * Why PRF and not largeBlob: largeBlob (used by webauthn-vault.ts for the
 * local biometric unlock) is platform-authenticator storage that does not
 * sync through password managers; PRF is a derivation, so every synced copy
 * of the passkey yields the same secret. Why not just store the keyring in
 * the manager as a field: that is the key string (vault/key-string.ts) — it
 * works everywhere but is a thing to copy. Both exist on purpose.
 *
 * Browser reality: PRF needs a secure context and a browser that implements
 * the extension (Chromium 116+, Safari 18+, Firefox 135+). Some authenticators
 * return the PRF output only from `get`, not from `create`, so enrolment does
 * a `create` and then immediately a `get` when needed.
 */

import {
  passkeyLoginOptions,
  passkeyLoginVerify,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@/lib/api/passkey'

const HKDF_INFO = 'onetothree-passkey-keyring-v1'

export type PasskeyError =
  | 'PASSKEY_UNSUPPORTED'
  | 'PRF_UNSUPPORTED'
  | 'PASSKEY_CANCELLED'
  | 'PASSKEY_NO_CREDENTIAL'
  | 'PASSKEY_SERVER_ERROR'
  | 'PASSKEY_UNSEAL_FAILED'

export class PasskeyKeyringError extends Error {
  readonly code: PasskeyError
  constructor(code: PasskeyError, cause?: unknown) {
    super(code)
    this.name = 'PasskeyKeyringError'
    this.code = code
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

// ── base64url ────────────────────────────────────────────────────────────────

export function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ── sealing (pure WebCrypto; unit-tested without WebAuthn) ───────────────────

async function deriveSealKey(prfSecret: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', prfSecret as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt as BufferSource, info: new TextEncoder().encode(HKDF_INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export type SealedKeyring = { hkdf_salt: string; wrap_iv: string; wrapped_keyring: string }

export async function sealKeyring(plaintext: string, prfSecret: Uint8Array): Promise<SealedKeyring> {
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveSealKey(prfSecret, hkdfSalt)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return { hkdf_salt: bytesToB64url(hkdfSalt), wrap_iv: bytesToB64url(iv), wrapped_keyring: bytesToB64url(ct) }
}

export async function unsealKeyring(sealed: SealedKeyring, prfSecret: Uint8Array): Promise<string> {
  const key = await deriveSealKey(prfSecret, b64urlToBytes(sealed.hkdf_salt))
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlToBytes(sealed.wrap_iv) },
      key,
      b64urlToBytes(sealed.wrapped_keyring),
    )
    return new TextDecoder().decode(pt)
  } catch (e) {
    throw new PasskeyKeyringError('PASSKEY_UNSEAL_FAILED', e)
  }
}

// ── WebAuthn plumbing ────────────────────────────────────────────────────────

export function isPasskeyAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function'
  )
}

type PrfOutputs = { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } }

function prfResult(cred: PublicKeyCredential): Uint8Array | null {
  const ext = cred.getClientExtensionResults() as { prf?: PrfOutputs }
  const first = ext.prf?.results?.first
  if (!first) return null
  return first instanceof Uint8Array ? first : new Uint8Array(first)
}

function prfEnabled(cred: PublicKeyCredential): boolean {
  const ext = cred.getClientExtensionResults() as { prf?: PrfOutputs }
  return ext.prf?.enabled === true
}

function toCreationOptions(
  json: PublicKeyCredentialCreationOptionsJSON,
  prfSalt: Uint8Array,
): PublicKeyCredentialCreationOptions {
  return {
    rp: json.rp,
    user: { id: b64urlToBytes(json.user.id), name: json.user.name, displayName: json.user.displayName },
    challenge: b64urlToBytes(json.challenge),
    pubKeyCredParams: json.pubKeyCredParams,
    timeout: json.timeout,
    excludeCredentials: json.excludeCredentials?.map((c) => ({
      id: b64urlToBytes(c.id),
      type: 'public-key' as const,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: json.authenticatorSelection,
    attestation: json.attestation,
    extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
  }
}

function toRequestOptions(
  json: PublicKeyCredentialRequestOptionsJSON,
  prfByCredential: Record<string, string>,
): PublicKeyCredentialRequestOptions {
  const evalByCredential: Record<string, { first: Uint8Array }> = {}
  for (const [id, salt] of Object.entries(prfByCredential)) {
    evalByCredential[id] = { first: b64urlToBytes(salt) }
  }
  return {
    challenge: b64urlToBytes(json.challenge),
    timeout: json.timeout,
    rpId: json.rpId,
    allowCredentials: json.allowCredentials?.map((c) => ({
      id: b64urlToBytes(c.id),
      type: 'public-key' as const,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    userVerification: json.userVerification,
    extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
  }
}

function registrationToJSON(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAttestationResponse
  const transports =
    typeof r.getTransports === 'function' ? r.getTransports() : undefined
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: (cred as { authenticatorAttachment?: string | null }).authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      attestationObject: bytesToB64url(r.attestationObject),
      transports,
    },
    clientExtensionResults: stripPrf(cred.getClientExtensionResults()),
  }
}

function assertionToJSON(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: (cred as { authenticatorAttachment?: string | null }).authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      authenticatorData: bytesToB64url(r.authenticatorData),
      signature: bytesToB64url(r.signature),
      userHandle: r.userHandle ? bytesToB64url(r.userHandle) : undefined,
    },
    clientExtensionResults: stripPrf(cred.getClientExtensionResults()),
  }
}

/** The PRF output is the secret — it must never travel to the server. */
function stripPrf(ext: AuthenticationExtensionsClientOutputs): Record<string, unknown> {
  const { prf: _prf, ...rest } = ext as Record<string, unknown> & { prf?: unknown }
  return rest
}

function mapWebAuthnError(e: unknown): PasskeyKeyringError {
  if (e instanceof PasskeyKeyringError) return e
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyKeyringError('PASSKEY_CANCELLED', e)
  if (name === 'NotSupportedError') return new PasskeyKeyringError('PASSKEY_UNSUPPORTED', e)
  return new PasskeyKeyringError('PASSKEY_SERVER_ERROR', e)
}

// ── Public flows ─────────────────────────────────────────────────────────────

/**
 * Enrol a passkey and seal the keyring under it.
 * @param keyringPlaintext the vault plaintext (what unwrapPrivateJwkWithPin returns)
 */
export async function enrolPasskeyKeyring(
  keyringPlaintext: string,
  label?: string,
): Promise<{ id: string }> {
  if (!isPasskeyAvailable()) throw new PasskeyKeyringError('PASSKEY_UNSUPPORTED')

  let optionsJson: PublicKeyCredentialCreationOptionsJSON
  try {
    optionsJson = (await passkeyRegisterOptions()).options
  } catch (e) {
    throw new PasskeyKeyringError('PASSKEY_SERVER_ERROR', e)
  }
  const prfSalt = crypto.getRandomValues(new Uint8Array(32))

  let cred: PublicKeyCredential
  try {
    const c = await navigator.credentials.create({ publicKey: toCreationOptions(optionsJson, prfSalt) })
    if (!c) throw new PasskeyKeyringError('PASSKEY_CANCELLED')
    cred = c as PublicKeyCredential
  } catch (e) {
    throw mapWebAuthnError(e)
  }

  let secret = prfResult(cred)
  if (!secret) {
    // The authenticator reported PRF support but only hands the output out on
    // an assertion (common). Ask it once, for the credential just made.
    if (!prfEnabled(cred)) throw new PasskeyKeyringError('PRF_UNSUPPORTED')
    try {
      const a = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: optionsJson.rp.id,
          allowCredentials: [{ id: cred.rawId, type: 'public-key' }],
          userVerification: 'required',
          extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
        },
      })
      if (!a) throw new PasskeyKeyringError('PASSKEY_CANCELLED')
      secret = prfResult(a as PublicKeyCredential)
    } catch (e) {
      throw mapWebAuthnError(e)
    }
    if (!secret) throw new PasskeyKeyringError('PRF_UNSUPPORTED')
  }

  const sealed = await sealKeyring(keyringPlaintext, secret)
  secret.fill(0)
  try {
    return await passkeyRegisterVerify({
      response: registrationToJSON(cred),
      label,
      prf_salt: bytesToB64url(prfSalt),
      ...sealed,
    })
  } catch (e) {
    throw new PasskeyKeyringError('PASSKEY_SERVER_ERROR', e)
  }
}

/**
 * On a device without the key: run the passkey, get the sealed keyring from
 * the server, unseal it. Returns the keyring plaintext for the caller to
 * wrap into a local vault with the user's password.
 */
export async function unlockKeyringWithPasskey(username: string): Promise<string> {
  if (!isPasskeyAvailable()) throw new PasskeyKeyringError('PASSKEY_UNSUPPORTED')

  let opts: Awaited<ReturnType<typeof passkeyLoginOptions>>
  try {
    opts = await passkeyLoginOptions(username)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    throw new PasskeyKeyringError(msg === 'NO_PASSKEY' ? 'PASSKEY_NO_CREDENTIAL' : 'PASSKEY_SERVER_ERROR', e)
  }

  let cred: PublicKeyCredential
  try {
    const c = await navigator.credentials.get({ publicKey: toRequestOptions(opts.options, opts.prf_salts) })
    if (!c) throw new PasskeyKeyringError('PASSKEY_CANCELLED')
    cred = c as PublicKeyCredential
  } catch (e) {
    throw mapWebAuthnError(e)
  }
  const secret = prfResult(cred)
  if (!secret) throw new PasskeyKeyringError('PRF_UNSUPPORTED')

  let sealed: SealedKeyring
  try {
    sealed = await passkeyLoginVerify(username, assertionToJSON(cred))
  } catch (e) {
    secret.fill(0)
    throw new PasskeyKeyringError('PASSKEY_SERVER_ERROR', e)
  }
  try {
    return await unsealKeyring(sealed, secret)
  } finally {
    secret.fill(0)
  }
}
