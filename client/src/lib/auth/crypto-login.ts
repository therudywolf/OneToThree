import { requestChallenge, verifyChallenge } from '@/lib/api/auth'
import {
  exportEcdsaPrivateKeyJwk,
  exportEcdsaPublicKeyJwk,
  exportPrivateKey,
  generateEcdsaP256KeyPair,
  generateKeyPair,
  importEcdsaPrivateKeyForSign,
  signUtf8WithEcdsaP256,
} from '@/lib/crypto'
import { parseVaultPlaintext, stringifyVaultKeyringV2 } from '@/lib/vault-keyring'
import {
  mirrorVaultLoginToUserId,
  persistVaultBlobByLoginUsername,
  readVaultBlobByLoginUsername,
  unwrapPrivateJwkWithPin,
  wrapPrivateJwkWithPin,
} from '@/lib/vault'

export type CryptoLoginResult =
  | { ok: true; user: { id: string; username: string } }
  | { ok: false; error: string }

export type CryptoLoginParams = {
  username: string
  password: string
  mode: 'login' | 'register'
}

/**
 * Challenge–response against Fastify: vault check → challenge → unwrap/sign → verify.
 * Registration generates ECDSA (auth) + ECDH (E2E); vault is written only after verify succeeds.
 */
export async function cryptoLogin(
  params: CryptoLoginParams
): Promise<CryptoLoginResult> {
  const username = params.username.trim()
  const password = params.password
  if (!username) {
    return { ok: false, error: 'USERNAME_REQUIRED' }
  }
  if (!password) {
    return { ok: false, error: 'PASSWORD_REQUIRED' }
  }
  if (params.mode === 'register' && password.length < 8) {
    return { ok: false, error: 'PIN_MIN_8' }
  }

  const hasVault = !!readVaultBlobByLoginUsername(username)

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
    const ecdsaPair = await generateEcdsaP256KeyPair()
    const ecdhPair = await generateKeyPair({ curve: 'P-256' })
    ecdsaPrivateJwk = await exportEcdsaPrivateKeyJwk(ecdsaPair.privateKey)
    ecdhPrivateJwkForVault = await exportPrivateKey(ecdhPair.privateKey)
    publicKeyJwk = await exportEcdsaPublicKeyJwk(ecdsaPair.publicKey)
  } else {
    const blob = readVaultBlobByLoginUsername(username)
    if (!blob) {
      return { ok: false, error: 'NO_LOCAL_VAULT' }
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
    if (parsed.kind === 'legacy_ecdh') {
      return { ok: false, error: 'LEGACY_VAULT_REQUIRES_REREGISTER' }
    }
    ecdsaPrivateJwk = parsed.ecdsaPrivateJwk
  }

  let nonce: string
  try {
    const ch = await requestChallenge(username)
    nonce = ch.nonce
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'CHALLENGE_FAILED',
    }
  }

  let signingKey: CryptoKey
  try {
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
    const { user } = await verifyChallenge({
      username,
      nonce,
      signature,
      public_key_jwk: publicKeyJwk,
    })

    if (params.mode === 'register' && ecdhPrivateJwkForVault) {
      const inner = stringifyVaultKeyringV2(
        ecdsaPrivateJwk,
        ecdhPrivateJwkForVault
      )
      const blob = await wrapPrivateJwkWithPin(inner, password)
      persistVaultBlobByLoginUsername(username, blob)
    }

    mirrorVaultLoginToUserId(username, user.id)

    return { ok: true, user }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'VERIFY_FAILED',
    }
  }
}
