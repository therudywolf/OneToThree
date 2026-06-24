type LoginTranslationKey =
  | 'errors.boundaryGeneric'
  | 'login.challengeFailed'
  | 'login.clientDeviceRequired'
  | 'login.deviceRevoked'
  | 'login.invalidBody'
  | 'login.invalidSigningKey'
  | 'login.invalidUsernameFormat'
  | 'login.invalidVaultFormat'
  | 'login.legacyVault'
  | 'login.noChallenge'
  | 'login.noLocalVault'
  | 'login.nonceMismatch'
  | 'login.passwordRequired'
  | 'login.pinMin8'
  | 'login.recoverPhraseInvalid'
  | 'login.recoverFailed'
  | 'login.recoverTotpRequired'
  | 'login.authLocked'
  | 'login.publicKeyConflict'
  | 'login.publicKeyRequired'
  | 'login.qrLinkFailedGeneric'
  | 'login.signFailed'
  | 'login.signatureInvalid'
  | 'login.totpInvalid'
  | 'login.totpPendingInvalid'
  | 'login.totpVerifyFailed'
  | 'login.tryAgainGeneric'
  | 'login.unauthorized'
  | 'login.usernameRequired'
  | 'login.usernameReserved'
  | 'login.usernameTaken'
  | 'login.unwrapFailed'
  | 'login.vaultExists'
  | 'login.vaultVersionMismatch'
  | 'login.verifyFailed'

type Translator = (key: LoginTranslationKey) => string

export function explainLoginError(code: string, t: Translator): string {
  const normalized = code.trim()
  if (!normalized) return t('errors.boundaryGeneric')

  const registry: Record<string, LoginTranslationKey> = {
    USERNAME_REQUIRED: 'login.usernameRequired',
    PASSWORD_REQUIRED: 'login.passwordRequired',
    PIN_MIN_8: 'login.pinMin8',
    NO_LOCAL_VAULT: 'login.noLocalVault',
    VAULT_ALREADY_EXISTS: 'login.vaultExists',
    UNWRAP_FAILED: 'login.unwrapFailed',
    INVALID_VAULT_FORMAT: 'login.invalidVaultFormat',
    LEGACY_VAULT_REQUIRES_REREGISTER: 'login.legacyVault',
    VAULT_VERSION_MISMATCH: 'login.vaultVersionMismatch',
    INVALID_SIGNING_KEY: 'login.invalidSigningKey',
    SIGN_FAILED: 'login.signFailed',
    CHALLENGE_FAILED: 'login.challengeFailed',
    INVALID_CHALLENGE_RESPONSE: 'login.challengeFailed',
    VERIFY_FAILED: 'login.verifyFailed',
    INVALID_VERIFY_RESPONSE: 'login.verifyFailed',
    SYS_FAULT: 'login.verifyFailed',
    UNAUTHORIZED: 'login.unauthorized',
    NO_CHALLENGE: 'login.noChallenge',
    NONCE_MISMATCH: 'login.nonceMismatch',
    SIGNATURE_INVALID: 'login.signatureInvalid',
    PUBLIC_KEY_REQUIRED: 'login.publicKeyRequired',
    PUBLIC_KEY_CONFLICT: 'login.publicKeyConflict',
    USERNAME_TAKEN: 'login.usernameTaken',
    INVALID_USERNAME_FORMAT: 'login.invalidUsernameFormat',
    USERNAME_RESERVED: 'login.usernameReserved',
    INVALID_BODY: 'login.invalidBody',
    TOTP_INVALID: 'login.totpInvalid',
    TOTP_ALREADY_USED: 'login.totpInvalid',
    INVALID_PENDING_TOKEN: 'login.totpPendingInvalid',
    TOTP_VERIFY_FAILED: 'login.totpVerifyFailed',
    TOTP_NOT_CONFIGURED: 'login.totpVerifyFailed',
    INVALID_2FA_RESPONSE: 'login.totpVerifyFailed',
    MFA_FAULT: 'login.totpVerifyFailed',
    CLIENT_DEVICE_ID_REQUIRED: 'login.clientDeviceRequired',
    DEVICE_REVOKED: 'login.deviceRevoked',
    QR_LOGIN_FAILED: 'login.qrLinkFailedGeneric',
    RECOVERY_PHRASE_INVALID: 'login.recoverPhraseInvalid',
    RECOVERY_COMPLETE_FAILED: 'login.recoverFailed',
    RECOVERY_CHALLENGE_FAILED: 'login.recoverFailed',
    RECOVERY_DECRYPT_FAILED: 'login.recoverFailed',
    RECOVERY_FAILED: 'login.recoverFailed',
    TOTP_STEP_UP_REQUIRED: 'login.recoverTotpRequired',
    AUTH_LOCKED: 'login.authLocked',
    BANNED_USER: 'login.unauthorized',
  }

  const key = registry[normalized]
  if (key) return t(key)

  if (
    normalized === 'INVALID_OR_EXPIRED_TOKEN' ||
    normalized === 'INVALID_OR_EXPIRED_LINK_TOKEN'
  ) {
    return t('login.qrLinkFailedGeneric')
  }

  // Surface the raw cause for UNMAPPED errors. Without this, native-app failures
  // (network/CORS "Failed to fetch", a WebView crypto/OOM throw, an unexpected
  // status) all collapse into one opaque "something went wrong" that's
  // impossible to diagnose remotely. Known errors keep their friendly text.
  // The human sentence stays calm; the raw code rides along in parentheses so
  // support can still pin down the cause from a screenshot.
  return `${t('login.tryAgainGeneric')} (${normalized.slice(0, 120)})`
}
