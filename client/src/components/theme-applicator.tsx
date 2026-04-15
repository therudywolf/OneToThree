'use client'

import { useEffect } from 'react'
import { useThemeStore } from '@/store/themeStore'

/**
 * PROJECT 13 :: CHROMATIC_APPLICATOR
 * Reads theme from store, stamps data-theme on <html>.
 * CSS vars in globals.css do the actual color swap.
 */
export function ThemeApplicator() {
  const theme = useThemeStore((s) => s.theme)

  useEffect(() => {
    const html = document.documentElement
    if (theme === 'default') {
      html.removeAttribute('data-theme')
    } else {
      html.setAttribute('data-theme', theme)
    }
  }, [theme])

  return null
}
