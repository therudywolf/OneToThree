import {
  complete2faLogin,
  requestChallenge,
  verifyChallenge,
} from '@/lib/api/auth'
import {
  exportEcdsaPublicKeyJwk,
  exportEcdhPublicJwkFromPrivateKeyString,
  generateEcdsaP256KeyPairIsolated,
  generateKeyPairIsolated,
  importEcdsaPrivateKeyForSign,
  signUtf8WithEcdsaP256,
} from '@/lib/crypto'
import { patchMyEcdhPublicKey } from '@/lib/api/users'
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
import { activateVaultSession } from '@/lib/vault/activate-vault'

export type CryptoLoginResult =
  /**
   * `warning` is a non-fatal degradation on an otherwise successful sign-in —
   * currently only 'ECDH_KEY_UPLOAD_FAILED' on the register path, where the
   * account already exists server-side and refusing would strand it.
   */
  | { ok: true; user: { id: string; username: string }; warning?: string }
  | { ok: 'needs_2fa'; pendingToken: string; userId: string }
  | { ok: false; error: string }

export type CryptoLoginParams = {
  username: string
  /**
   * vault-password: единственный пароль.
   * AES-GCM(PBKDF2(vault-password, 600k)) → ECDSA private key → localStorage.
   * Сервер его не знает никогда — только ECDSA-подпись уходит наружу.
   * Один vault-файл можно перенести на любое устройство — пароль работает везде.
   * Второй фактор — TOTP (настраивается отдельно после входа).
   */
  vaultPassword: string
  mode: 'login' | 'register'
}

/**
 * SECURITY MODEL
 * ==============
 * Единственный секрет: vault-password.
 * Расшифровывает ECDSA ключ в localStorage.
 * Работает на любом устройстве если есть vault-файл.
 * Утек файла без пароля → бесполезно.
 * Знание пароля без файла → бесполезно.
 * TOTP — второй фактор, настраивается отдельно после входа.
 */
export async function finalizeLoginWithTotp(params: {
  pendingToken: string
  code: string
  canonicalHandle: string
  /**
   * The one password, carried through the 2FA step so these users also skip the
   * redundant unlock prompt. `cryptoLogin` returns `needs_2fa` BEFORE it can
   * activate the vault, so without this a 2FA user would still be asked for the
   * very same string a second time. Optional: omit it and the unlock modal
   * simply takes over, exactly as before.
   */
  vaultPassword?: string
}): Promise<
  { ok: true; user: { id: string; username: string } } | { ok: false; error: string }
> {
  const nick = parseNickname(params.canonicalHandle)
  if (!nick.ok) return { ok: false, error: nick.error }
  try {
    const { user } = await complete2faLogin(
      params.pendingToken,
      params.code.replace(/\D/g, '').slice(0, 6)
    )
    mirrorVaultLoginToUserId(nick.value, user.id)

    if (params.vaultPassword) {
      // Best-effort — never turn a successful 2FA login into a failure.
      try {
        const blob = readVaultBlobByLoginUsername(nick.value)
        if (blob && blob.version <= CURRENT_VAULT_VERSION) {
          const plain = await unwrapPrivateJwkWithPin(blob, params.vaultPassword)
          await activateVaultSession(plain, user.id)
        }
      } catch {
        /* fall back to the unlock modal */
      }
    }
    return { ok: true, user }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'TOTP_VERIFY_FAILED' }
  }
}

export async function cryptoLogin(
  params: CryptoLoginParams
): Promise<CryptoLoginResult> {
  const username      = params.username.trim()
  const vaultPassword = params.vaultPassword

  if (!username)      return { ok: false, error: 'USERNAME_REQUIRED' }
  if (!vaultPassword) return { ok: false, error: 'PASSWORD_REQUIRED' }

  const nick = parseNickname(username)
  if (!nick.ok) return { ok: false, error: nick.error }
  const canonicalHandle = nick.value

  if (params.mode === 'register' && vaultPassword.length < 8) {
    return { ok: false, error: 'PIN_MIN_8' }
  }

  const hasVault = !!readVaultBlobByLoginUsername(canonicalHandle)
  if (params.mode === 'login'    && !hasVault) return { ok: false, error: 'NO_LOCAL_VAULT' }
  if (params.mode === 'register' &&  hasVault) return { ok: false, error: 'VAULT_ALREADY_EXISTS' }

  let ecdsaPrivateJwk: string
  let publicKeyJwk: string | undefined
  let ecdhPrivateJwkForVault: string | undefined

  if (params.mode === 'register') {
    const ecdsaPair = await generateEcdsaP256KeyPairIsolated()
    const ecdhPair  = await generateKeyPairIsolated({ curve: 'P-256' })
    ecdsaPrivateJwk        = ecdsaPair.privateJwk
    ecdhPrivateJwkForVault = ecdhPair.privateJwk
    publicKeyJwk           = await exportEcdsaPublicKeyJwk(ecdsaPair.publicKey)
  } else {
    const blob = readVaultBlobByLoginUsername(canonicalHandle)
    if (!blob) return { ok: false, error: 'NO_LOCAL_VAULT' }
    if (blob.version > CURRENT_VAULT_VERSION) return { ok: false, error: 'VAULT_VERSION_MISMATCH' }
    let plain: string
    try {
      plain = await unwrapPrivateJwkWithPin(blob, vaultPassword)
    } catch {
      return { ok: false, error: 'UNWRAP_FAILED' }
    }
    const parsed = parseVaultPlaintext(plain)
    if (!parsed)                  return { ok: false, error: 'INVALID_VAULT_FORMAT' }
    if (parsed.kind === 'LEGACY') return { ok: false, error: 'LEGACY_VAULT_REQUIRES_REREGISTER' }
    ecdsaPrivateJwk        = parsed.ecdsaJwk
    ecdhPrivateJwkForVault = parsed.ecdhJwk
  }

  let nonce: string
  try {
    const ch = await requestChallenge(canonicalHandle)
    nonce = ch.nonce
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'CHALLENGE_FAILED' }
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
    const vr = await verifyChallenge({
      username: canonicalHandle,
      nonce,
      signature,
      public_key_jwk: publicKeyJwk,
    })

    if (vr.kind === '2fa_pending') {
      return { ok: 'needs_2fa', pendingToken: vr.pendingToken, userId: vr.userId }
    }

    const { user } = vr

    if (params.mode === 'register' && ecdhPrivateJwkForVault) {
      const inner = stringifyVaultKeyringV2(ecdsaPrivateJwk, ecdhPrivateJwkForVault)
      const blob  = await wrapPrivateJwkWithPin(inner, vaultPassword)
      persistVaultBlobByLoginUsername(canonicalHandle, blob)
    }

    // Upload ECDH public key so this device is reachable for fan-out
    // encryption. On register: freshly generated key. On login: the key
    // already stored in the vault.
    //
    // BLOCKING by design (was previously fire-and-forget): if this races
    // with the chat bootstrap's first send, the server records `null` as
    // the sender ECDH key and recipients can't decrypt. Failure here is
    // not "non-fatal" — we surface it so the UI can ask the user to retry
    // before they start typing.
    //
    // ...but NOT on register. By this point POST /auth/verify has already
    // succeeded, the account exists server-side, the session cookie is set and
    // the vault blob is on disk. Returning {ok:false} orphaned that account:
    // the caller skipped `markBackupPending` and the post-register backup
    // prompt — the only warning this product ever gives about permanent account
    // loss — and a retry then hit VAULT_ALREADY_EXISTS because the blob was
    // there. So retry once (transient blips are common right here) and, on
    // register, fall through with a warning: `activateVaultSession` below
    // retries the same upload again anyway.
    let ecdhUploadError: string | null = null
    if (ecdhPrivateJwkForVault) {
      const myPubJwk = exportEcdhPublicJwkFromPrivateKeyString(ecdhPrivateJwkForVault)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await patchMyEcdhPublicKey(myPubJwk, ecdsaPrivateJwk)
          ecdhUploadError = null
          break
        } catch (e) {
          ecdhUploadError = e instanceof Error ? e.message : 'ECDH_KEY_UPLOAD_FAILED'
        }
      }
      if (ecdhUploadError && params.mode !== 'register') {
        return { ok: false, error: ecdhUploadError }
      }
      if (ecdhUploadError) {
        console.warn('[register] ECDH key upload failed — retrying at vault activation', ecdhUploadError)
      }
    }

    mirrorVaultLoginToUserId(canonicalHandle, user.id)

    // Bring the session fully online right here. There is only ONE password in
    // this product — it never reaches the server, and its only job is wrapping
    // this vault — so the keyring we just decrypted (login) or generated
    // (register) is exactly what the unlock modal would ask for. Prompting for
    // the same string a second time is what made people believe the "account
    // password" and the "vault password" were two different things.
    //
    // Best-effort: a failure here is NOT a login failure. The user is
    // authenticated either way, and the vault modal remains as the fallback
    // surface (it is still required after a reload, idle auto-lock, or manual
    // lock, since the unwrapped key is memory-only and never persisted).
    if (ecdsaPrivateJwk && ecdhPrivateJwkForVault) {
      try {
        await activateVaultSession(
          stringifyVaultKeyringV2(ecdsaPrivateJwk, ecdhPrivateJwkForVault),
          user.id
        )
      } catch {
        /* fall back to the unlock modal */
      }
    }
    return ecdhUploadError
      ? { ok: true, user, warning: 'ECDH_KEY_UPLOAD_FAILED' }
      : { ok: true, user }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'VERIFY_FAILED' }
  }
}
