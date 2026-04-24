import type { StickerPack } from '@/lib/api/stickers'

type StickerTranslationKey =
  | 'errors.boundaryGeneric'
  | 'settings.loadFailed'
  | 'settings.stickersBackendOutdated'
  | 'settings.stickersOwnerOnly'
  | 'settings.stickersScopeOwned'
  | 'settings.stickersScopePublic'
  | 'settings.stickersScopeShared'
  | 'stickers.saveFailed'

type Translator = (key: StickerTranslationKey) => string

export function explainStickerError(code: string, t: Translator): string {
  const normalized = code.trim()
  if (!normalized) return t('errors.boundaryGeneric')

  if (
    normalized === 'FORBIDDEN' ||
    normalized.startsWith('DELETE_PACK_403') ||
    normalized.startsWith('REFRESH_PACK_403')
  ) {
    return t('settings.stickersOwnerOnly')
  }
  if (
    normalized === 'DATABASE_SCHEMA_MISMATCH' ||
    normalized.startsWith('FETCH_PACKS_503')
  ) {
    return t('settings.stickersBackendOutdated')
  }
  if (
    normalized.startsWith('FETCH_PACKS_') ||
    normalized.startsWith('FETCH_STICKERS_')
  ) {
    return t('settings.loadFailed')
  }
  if (
    normalized === 'CLONE_PACK_FAILED' ||
    normalized === 'STICKER_SAVE_FAILED'
  ) {
    return t('stickers.saveFailed')
  }
  return t('errors.boundaryGeneric')
}

export function formatStickerAccessScope(
  scope: StickerPack['accessScope'],
  t: Translator
): string {
  if (scope === 'owned') return t('settings.stickersScopeOwned')
  if (scope === 'public') return t('settings.stickersScopePublic')
  return t('settings.stickersScopeShared')
}
