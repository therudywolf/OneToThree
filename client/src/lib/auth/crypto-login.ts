import {
  complete2faLogin,
  requestChallenge,
  verifyChallenge,
} from '@/lib/api/auth'
import {
  exportEcdsaPublicKeyJwk,
  generateEcdsaP256KeyPairIsolated,
  generateKeyPairIsolated,
  importEcdsaPrivateKeyForSign,
  signUtf8WithEcdsaP256,
} from '@/lib/crypto'
import { parseVaultPlaintext, stringifyVaultKeyringV2 } from '@/lib/vault-keyring'
import {
  CURRENT_VAULT_VERSION,
  mirrorVaultLoginToUserId,
  persistVaultBlobByLoginUsername,
  readVaultBlobByLoginUsername,
  unwrapPrivateJwkWithPin,
  wrapPrivateJwkWithPin,
} from '@/lib/vault'
import { parseNickname } from '@/lib/nickname'

export type CryptoLoginResult =
  | { ok: true; user: { id: string; username: string } }
  | { ok: 'needs_2fa'; pendingToken: string; userId: string }
  | { ok: false; error: string }

export type CryptoLoginParams = {
  username: string
  password: string
  /** Separate vault encryption password (registration only). Falls back to `password` when omitted. */
  vaultPassword?: string
  mode: 'login' | 'register'
}

/**
 * After ECDSA verify returned `needs_2fa`, submit TOTP and attach session cookie.
 */
export async function finalizeLoginWithTotp(params: {
  pendingToken: string
  code: string
  canonicalHandle: string
}): Promise<
  { ok: true; user: { id: string; username: string } } | { ok: false; error: string }
> {
  const nick = parseNickname(params.canonicalHandle)
  if (!nick.ok) {
    return { ok: false, error: nick.error }
  }
  try {
    const { user } = await complete2faLogin(
      params.pendingToken,
      params.code.replace(/\D/g, '').slice(0, 6)
    )
    mirrorVaultLoginToUserId(nick.value, user.id)
    return { ok: true, user }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'TOTP_VERIFY_FAILED',
    }
  }
}

/**
 * Challenge–response against Fastify: vault check → challenge → unwrap/sign → verify.
 * Registration generates ECDSA (auth) + ECDH (E2E); vault is written only after verify succeeds.
 *
 * Stage 1 key isolation: both key pairs are generated via isolated helpers that
 * re-import the private key as extractable:false before returning, closing the
 * XSS exfiltration window on the in-memory CryptoKey object.
 */
export async function cryptoLogin(
  params: CryptoLoginParams
): Promise<CryptoLoginResult> {
  const username = params.username.trim()
  const password = params.password
  if (!username) {
    return { ok: false, error: 'USERNAME_REQUIRED' }
  }
  const nick = parseNickname(username)
  if (!nick.ok) {
    return { ok: false, error: nick.error }
  }
  const canonicalHandle = nick.value
  if (!password) {
    return { ok: false, error: 'PASSWORD_REQUIRED' }
  }
  if (params.mode === 'register' && password.length < 8) {
    return { ok: false, error: 'PIN_MIN_8' }
  }
  if (params.mode === 'register' && params.vaultPassword && params.vaultPassword.length < 8) {
    return { ok: false, error: 'PIN_MIN_8' }
  }

  const hasVault = !!readVaultBlobByLoginUsername(canonicalHandle)

  if (params.mode === 'login' && !hasVault) {
    return { ok: false, error: 'NO_LOCAL_VAULT' }
  }
  if (params.mode === 'register' && hasVault) {
    return { ok: false, error: 'VAULT_ALREADY_EXISTS' }
  }

  let ecdsaPrivateJwk: string
  let publicKeyJwk: string | undefined
  let ecdhPrivateJwkForVault: string | undefined

  if (params.mode === 'register') {
    // Stage 1: isolated helpers — privateKey is non-extractable in memory after this point
    const ecdsaPair = await generateEcdsaP256KeyPairIsolated()
    const ecdhPair  = await generateKeyPairIsolated({ curve: 'P-256' })

    ecdsaPrivateJwk      = ecdsaPair.privateJwk
    ecdhPrivateJwkForVault = ecdhPair.privateJwk
    publicKeyJwk         = await exportEcdsaPublicKeyJwk(ecdsaPair.publicKey)
  } else {
    const blob = readVaultBlobByLoginUsername(canonicalHandle)
    if (!blob) {
      return { ok: false, error: 'NO_LOCAL_VAULT' }
    }
    if (blob.version > CURRENT_VAULT_VERSION) {
      return { ok: false, error: 'VAULT_VERSION_MISMATCH' }
    }
    let plain: string
    try {
      plain = await unwrapPrivateJwkWithPin(blob, password)
    } catch {
      return { ok: false, error: 'UNWRAP_FAILED' }
    }

    const parsed = parseVaultPlaintext(plain)
    if (!parsed) {
      return { ok: false, error: 'INVALID_VAULT_FORMAT' }
    }
    if (parsed.kind === 'LEGACY') {
      return { ok: false, error: 'LEGACY_VAULT_REQUIRES_REREGISTER' }
    }
    ecdsaPrivateJwk = parsed.ecdsaJwk
  }

  let nonce: string
  try {
    const ch = await requestChallenge(canonicalHandle)
    nonce = ch.nonce
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'CHALLENGE_FAILED',
    }
  }

  let signingKey: CryptoKey
  try {
    // importEcdsaPrivateKeyForSign always imports as extractable:false
    signingKey = await importEcdsaPrivateKeyForSign(ecdsaPrivateJwk)
  } catch {
    return { ok: false, error: 'INVALID_SIGNING_KEY' }
  }

  let signature: string
  try {
    signature = await signUtf8WithEcdsaP256(signingKey, nonce)
  } catch {
    return { ok: false, error: 'SIGN_FAILED' }
  }

  try {
    const vr = await verifyChallenge({
      username: canonicalHandle,
      nonce,
      signature,
      public_key_jwk: publicKeyJwk,
    })

    if (vr.kind === '2fa_pending') {
      return {
        ok: 'needs_2fa',
        pendingToken: vr.pendingToken,
        userId: vr.userId,
      }
    }

    const { user } = vr

    if (params.mode === 'register' && ecdhPrivateJwkForVault) {
      const inner = stringifyVaultKeyringV2(
        ecdsaPrivateJwk,
        ecdhPrivateJwkForVault
      )
      const vaultPin = params.vaultPassword || password
      const blob = await wrapPrivateJwkWithPin(inner, vaultPin)
      persistVaultBlobByLoginUsername(canonicalHandle, blob)
    }

    mirrorVaultLoginToUserId(canonicalHandle, user.id)

    return { ok: true, user }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'VERIFY_FAILED',
    }
  }
}
