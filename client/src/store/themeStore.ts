'use client'

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * PROJECT 13 :: CHROMATIC_PROTOCOL_CORE
 * Level: Interface Layer (Visual Preference)
 * Vibe: Clinical / Terminal Noir
 */

export type ThemeId =
  | 'default'
  | 'cyberpunk2077'
  | 'matrix'
  | 'dracula'
  | 'midnight'

export interface ThemeConfig {
  id: ThemeId
  label: string
  bg: string
  primary: string
  accent: string
}

export const THEMES: ThemeConfig[] = [
  { id: 'default',       label: 'VOID // DEFAULT',  bg: '#000000', primary: '#FF0000', accent: '#00FFFF' },
  { id: 'cyberpunk2077', label: 'CYBERPUNK 2077',   bg: '#0D0208', primary: '#FCE700', accent: '#FF003C' },
  { id: 'matrix',        label: 'MATRIX // GREEN',  bg: '#000000', primary: '#00FF41', accent: '#003B00' },
  { id: 'dracula',       label: 'DRACULA',          bg: '#282A36', primary: '#FF79C6', accent: '#8BE9FD' },
  { id: 'midnight',      label: 'MIDNIGHT BLUE',    bg: '#0A0E1A', primary: '#4FC3F7', accent: '#E0F7FA' },
]

type ChromaticState = {
  theme: ThemeId
  setTheme: (id: ThemeId) => void
}

export const useThemeStore = create<ChromaticState>()(
  persist(
    (set) => ({
      theme: 'default',
      setTheme: (id) => set({ theme: id }),
    }),
    {
      name: 'fm_chromatic_config',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme }),
    }
  )
)
