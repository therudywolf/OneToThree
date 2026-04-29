type DeviceLinkTranslationKey =
  | 'errors.boundaryGeneric'
  | 'login.qrAuthInvalidLink'
  | 'login.qrLinkFailedGeneric'
  | 'login.qrLinkExpired'
  | 'login.qrLinkDisabled'
  | 'login.qrLinkDeviceIdError'
  | 'login.qrVaultMissing'
  | 'login.deviceRevoked'
  | 'login.signatureInvalid'
  | 'login.totpInvalid'
  | 'login.totpVerifyFailed'
  | 'login.legacyVaultNoEcdsa'

type Translator = (key: DeviceLinkTranslationKey) => string

export function explainDeviceLinkError(code: string, t: Translator): string {
  const normalized = code.trim()
  if (!normalized) return t('errors.boundaryGeneric')

  if (
    normalized === 'INVALID_OR_EXPIRED_TOKEN' ||
    normalized === 'INVALID_OR_EXPIRED_LINK_TOKEN'
  ) {
    return t('login.qrLinkExpired')
  }
  if (normalized === 'INVALID_LINK_TOKEN' || normalized === 'INVALID_LINK') {
    return t('login.qrAuthInvalidLink')
  }
  if (normalized === 'DEVICE_LINKING_DISABLED') {
    return t('login.qrLinkDisabled')
  }
  if (normalized === 'CLIENT_DEVICE_ID_REQUIRED') {
    return t('login.qrLinkDeviceIdError')
  }
  if (normalized === 'VAULT_NOT_FOUND') {
    return t('login.qrVaultMissing')
  }
  if (normalized === 'DEVICE_REVOKED') {
    return t('login.deviceRevoked')
  }
  if (normalized === 'SIGNATURE_INVALID') {
    return t('login.signatureInvalid')
  }
  if (normalized === 'TOTP_STATE_INVALID') {
    return t('login.totpVerifyFailed')
  }
  if (normalized === 'TOTP_INVALID' || normalized === 'TOTP_ALREADY_USED') {
    return t('login.totpInvalid')
  }
  if (normalized === 'ECDSA_KEY_MISSING_IN_VAULT') {
    return t('login.legacyVaultNoEcdsa')
  }
  return t('errors.boundaryGeneric')
}
