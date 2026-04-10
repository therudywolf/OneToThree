'use client'

import { useMemo } from 'react'
import en from '@/locales/en'
import ru from '@/locales/ru'
import { useLocaleStore } from '@/store/localeStore'

type TranslationShape = typeof en
type Dictionary = Record<keyof TranslationShape, string>
export type TranslationKey = keyof TranslationShape

const dictByLocale: Record<'en' | 'ru', Dictionary> = {
  en,
  ru,
}

export function useTranslation() {
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)
  const toggleLocale = useLocaleStore((s) => s.toggleLocale)

  const dict = useMemo(() => dictByLocale[locale], [locale])
  const t = (key: TranslationKey): string => dict[key] ?? key

  return { locale, setLocale, toggleLocale, t }
}

