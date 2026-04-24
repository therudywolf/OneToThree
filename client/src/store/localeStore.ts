'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeJSONStorage } from '@/lib/safe-zustand-storage'

/**
 * PROJECT 13 :: LINGUISTIC_PROTOCOL_CORE
 * Level: Interface Layer (User Preference)
 * Vibe: Clinical / Terminal Noir
 */

export type LocaleSegment = 'en' | 'ru'

type LinguisticState = {
  // [DATA_NODE]
  module: LocaleSegment
  
  // [OPERATIONS]
  setModule: (segment: LocaleSegment) => void
  cycleProtocol: () => void
}

export const useLocaleStore = create<LinguisticState>()(
  persist(
    (set, get) => ({
      // Default node configuration
      module: 'ru', // Ставим ru по дефолту, мы же в лесу

      /** Установка конкретного языкового сегмента */
      setModule: (segment) => set({ module: segment }),

      /** Инверсия лингвистического протокола (Toggle) */
      cycleProtocol: () =>
        set({ module: get().module === 'en' ? 'ru' : 'en' }),
    }),
    {
      name: 'fm_linguistic_config',
      storage: createSafeJSONStorage(),
      // Изолируем только необходимые данные для сохранения
      partialize: (state) => ({ module: state.module }),
    }
  )
)
