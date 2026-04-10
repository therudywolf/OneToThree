'use client'

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type Locale = 'en' | 'ru'

type LocaleState = {
  locale: Locale
  setLocale: (locale: Locale) => void
  toggleLocale: () => void
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set, get) => ({
      locale: 'en',
      setLocale: (locale) => set({ locale }),
      toggleLocale: () =>
        set({ locale: get().locale === 'en' ? 'ru' : 'en' }),
    }),
    {
      name: 'fm_locale',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ locale: s.locale }),
    }
  )
)

