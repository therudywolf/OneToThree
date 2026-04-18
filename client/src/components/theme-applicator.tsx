'use client'

import { useEffect } from 'react'
import { resolveThemeAppearance, useThemeStore } from '@/store/themeStore'

/**
 * PROJECT 13 :: CHROMATIC_APPLICATOR
 * Reads theme from store, stamps data-theme on <html>.
 * CSS vars in globals.css do the actual color swap.
 */
export function ThemeApplicator() {
  const appearance = useThemeStore((s) => ({
    theme: s.theme,
    accentPreset: s.accentPreset,
    primaryColorOverride: s.primaryColorOverride,
    accentColorOverride: s.accentColorOverride,
    backgroundColorOverride: s.backgroundColorOverride,
    motionMode: s.motionMode,
  }))

  useEffect(() => {
    const html = document.documentElement
    const resolved = resolveThemeAppearance(appearance)
    html.setAttribute('data-theme', resolved.id)
    html.setAttribute('data-motion', resolved.motionMode)
    html.style.colorScheme = resolved.scheme
    html.style.setProperty('--void', resolved.tokens.background)
    html.style.setProperty('--surface', resolved.tokens.surface)
    html.style.setProperty('--surface-elevated', resolved.tokens.elevated)
    html.style.setProperty('--on-surface', resolved.tokens.text)
    html.style.setProperty('--text-primary', resolved.tokens.text)
    html.style.setProperty('--text-muted', resolved.tokens.muted)
    html.style.setProperty('--neon-red', resolved.tokens.primary)
    html.style.setProperty('--neon-cyan', resolved.tokens.accent)
    html.style.setProperty('--accent-2', resolved.tokens.accentSoft)
    html.style.setProperty('--border-strong', resolved.tokens.border)
    html.style.setProperty('--danger', resolved.tokens.danger)
    html.style.setProperty('--success', resolved.tokens.success)
    html.style.setProperty('--shadow-rgb', resolved.tokens.shadowRgb)
    html.style.setProperty('--crt-opacity', resolved.tokens.crtOpacity)
    html.style.setProperty('--crt-vignette-opacity', resolved.tokens.crtVignetteOpacity)
    html.style.setProperty('--font-family', resolved.tokens.fontFamily)
    html.style.setProperty('--border-radius', resolved.tokens.panelRadius)
    html.style.setProperty('--radius-md', resolved.tokens.controlRadius)
    html.style.setProperty('--page-glow', resolved.tokens.pageGlow)
    html.style.setProperty('--page-glow-secondary', resolved.tokens.pageGlowSecondary)
    html.style.setProperty(
      '--motion-fast',
      resolved.motionMode === 'reduced' ? '0ms' : '120ms'
    )
    html.style.setProperty(
      '--motion-base',
      resolved.motionMode === 'reduced' ? '0ms' : '220ms'
    )
    html.style.setProperty(
      '--motion-slow',
      resolved.motionMode === 'reduced' ? '0ms' : '360ms'
    )

    const themeMeta = document.querySelector('meta[name="theme-color"]')
    if (themeMeta) {
      themeMeta.setAttribute('content', resolved.themeColor)
    }
  }, [appearance])

  return null
}
