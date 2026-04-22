'use client'

import { useCallback, useMemo } from 'react'
import en from '@/locales/en'
import ru from '@/locales/ru'
import { useLocaleStore } from '@/store/localeStore'

/**
 * PROJECT 13 :: LINGUISTIC_INTERPRETER_NODE
 * Level: Interface Layer (L10n)
 * Vibe: Clinical Pure / Terminal Noir
 */

type TranslationShape = typeof en
type Dictionary = Record<keyof TranslationShape, string>
export type TranslationKey = keyof TranslationShape
export type TranslateFn = (key: TranslationKey) => string

const segmentMap: Record<'en' | 'ru', Dictionary> = {
  en,
  ru,
}

/**
 * Хук для перевода ключей в дешифрованный текст.
 * Синхронизирован с ядром стора (module / cycleProtocol).
 */
export function useTranslation() {
  const { module, setModule, cycleProtocol } = useLocaleStore()

  // [DECRYPTION_DICTIONARY] :: Выбор активного словаря на основе сегмента
  const dict = useMemo(() => segmentMap[module], [module])

  /** * [T_FUNCTION] :: Стабильный переводчик.
   * Возвращает ключ, если перевод в секторе не найден.
   */
  const t = useCallback(
    (key: TranslationKey): string => dict[key] ?? key,
    [dict]
  )

  return { 
    module,      // Активный сегмент (en/ru)
    setModule,   // Принудительная установка сегмента
    cycleProtocol, // Инверсия сегмента (Toggle)
    t            // Функция перевода
  }
}