type SettingsTranslationKey =
  | 'errors.boundaryGeneric'
  | 'login.totpInvalid'
  | 'login.totpVerifyFailed'
  | 'login.unauthorized'
  | 'profile.saveFailed'
  | 'settings.killPinBad'
  | 'settings.loadFailed'
  | 'settings.noLocalVault'
  | 'settings.toggleFailed'
  | 'settings.unknown'

type Translator = (key: SettingsTranslationKey) => string

export function explainSettingsError(
  code: string,
  t: Translator,
  fallback: SettingsTranslationKey = 'settings.unknown'
): string {
  const normalized = code.trim()
  if (!normalized) return t(fallback)

  const registry: Record<string, SettingsTranslationKey> = {
    NO_LOCAL_VAULT: 'settings.noLocalVault',
    UNAUTHORIZED: 'login.unauthorized',
    DEVICES_FETCH_FAILED: 'settings.loadFailed',
    DEVICE_NOT_FOUND: 'settings.loadFailed',
    TOTP_INVALID: 'login.totpInvalid',
    TOTP_ALREADY_USED: 'login.totpInvalid',
    INVALID_PENDING_TOKEN: 'login.totpVerifyFailed',
    TOTP_NOT_CONFIGURED: 'login.totpVerifyFailed',
    TOTP_VERIFY_FAILED: 'login.totpVerifyFailed',
    TOTP_STATE_INVALID: 'login.totpVerifyFailed',
    INVALID_2FA_RESPONSE: 'login.totpVerifyFailed',
    MFA_FAULT: 'login.totpVerifyFailed',
    NOTIFICATION_MODE_SAVE_FAILED: 'settings.toggleFailed',
  }

  const direct = registry[normalized]
  if (direct) return t(direct)

  if (
    normalized.includes('decrypt') ||
    normalized.includes('unwrap') ||
    normalized.includes('OperationError')
  ) {
    return t('settings.killPinBad')
  }

  if (normalized.startsWith('FETCH_') || normalized.endsWith('_FETCH_FAILED')) {
    return t('settings.loadFailed')
  }

  if (normalized.endsWith('_FAILED') || normalized === 'SERVER_ERROR') {
    return t(fallback)
  }

  return t(fallback)
}
