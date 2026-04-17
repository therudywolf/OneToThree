'use client'

import { useEffect } from 'react'
import { THEME_BY_ID, useThemeStore } from '@/store/themeStore'

/**
 * PROJECT 13 :: CHROMATIC_APPLICATOR
 * Reads theme from store, stamps data-theme on <html>.
 * CSS vars in globals.css do the actual color swap.
 */
export function ThemeApplicator() {
  const theme = useThemeStore((s) => s.theme)

  useEffect(() => {
    const html = document.documentElement
    const themeConfig = THEME_BY_ID[theme] ?? THEME_BY_ID.default
    html.setAttribute('data-theme', theme)
    html.style.colorScheme = themeConfig.scheme

    const themeMeta = document.querySelector('meta[name="theme-color"]')
    if (themeMeta) {
      themeMeta.setAttribute('content', themeConfig.themeColor)
    }
  }, [theme])

  return null
}
