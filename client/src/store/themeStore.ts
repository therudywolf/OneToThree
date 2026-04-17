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
  | 'synthwave'
  | 'hacker'
  | 'md3dark'
  | 'md3light'

export interface ThemeConfig {
  id: ThemeId
  label: string
  bg: string
  primary: string
  accent: string
  scheme: 'dark' | 'light'
  themeColor: string
}

export const THEMES: ThemeConfig[] = [
  { id: 'default',       label: 'VOID // DEFAULT',    bg: '#000000', primary: '#FF0000', accent: '#00FFFF', scheme: 'dark', themeColor: '#000000' },
  { id: 'cyberpunk2077', label: 'CYBERPUNK 2077',     bg: '#0D0208', primary: '#FCE700', accent: '#FF003C', scheme: 'dark', themeColor: '#0D0208' },
  { id: 'matrix',        label: 'MATRIX // GREEN',    bg: '#000000', primary: '#00FF41', accent: '#003B00', scheme: 'dark', themeColor: '#000000' },
  { id: 'dracula',       label: 'DRACULA',            bg: '#282A36', primary: '#FF79C6', accent: '#8BE9FD', scheme: 'dark', themeColor: '#282A36' },
  { id: 'midnight',      label: 'MIDNIGHT BLUE',      bg: '#0A0E1A', primary: '#4FC3F7', accent: '#E0F7FA', scheme: 'dark', themeColor: '#0A0E1A' },
  { id: 'synthwave',     label: 'SYNTHWAVE // RETRO', bg: '#0D0221', primary: '#F92AAD', accent: '#A537FD', scheme: 'dark', themeColor: '#0D0221' },
  { id: 'hacker',        label: 'HACKER // AMBER',    bg: '#0C0C00', primary: '#FFB300', accent: '#FF6D00', scheme: 'dark', themeColor: '#0C0C00' },
  { id: 'md3dark',       label: 'MD3 // DARK',        bg: '#0F0F11', primary: '#A8C7FA', accent: '#C3C7CF', scheme: 'dark', themeColor: '#0F0F11' },
  { id: 'md3light',      label: 'MD3 // LIGHT',       bg: '#FAFCFF', primary: '#0062A1', accent: '#535F70', scheme: 'light', themeColor: '#FAFCFF' },
]

export const THEME_BY_ID: Record<ThemeId, ThemeConfig> = THEMES.reduce(
  (acc, theme) => {
    acc[theme.id] = theme
    return acc
  },
  {} as Record<ThemeId, ThemeConfig>
)

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
