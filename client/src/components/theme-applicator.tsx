'use client'

import { useEffect } from 'react'
import { resolveThemeAppearance, useThemeStore } from '@/store/themeStore'

/**
 * CHROMATIC_APPLICATOR
 * Single source of truth for theme application.
 * Reads themeStore, resolves tokens, stamps them on <html> via inline CSS vars.
 * No [data-theme] CSS blocks needed — ThemeApplicator owns everything.
 */
export function ThemeApplicator() {
  const theme = useThemeStore((s) => s.theme)
  const accentPreset = useThemeStore((s) => s.accentPreset)
  const primaryColorOverride = useThemeStore((s) => s.primaryColorOverride)
  const accentColorOverride = useThemeStore((s) => s.accentColorOverride)
  const backgroundColorOverride = useThemeStore((s) => s.backgroundColorOverride)
  const motionMode = useThemeStore((s) => s.motionMode)

  useEffect(() => {
    const html = document.documentElement
    const resolved = resolveThemeAppearance({
      theme,
      accentPreset,
      primaryColorOverride,
      accentColorOverride,
      backgroundColorOverride,
      motionMode,
    })

    // --- color scheme & data-theme ---
    html.setAttribute('data-theme', resolved.id)
    html.setAttribute('data-motion', resolved.motionMode)
    html.style.colorScheme = resolved.scheme

    // --- core color tokens ---
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

    // --- CRT effect ---
    html.style.setProperty('--crt-opacity', resolved.tokens.crtOpacity)
    html.style.setProperty('--crt-vignette-opacity', resolved.tokens.crtVignetteOpacity)

    // --- typography ---
    html.style.setProperty('--font-family', resolved.tokens.fontFamily)
    const isMd3 = resolved.id === 'md3dark' || resolved.id === 'md3light'
    html.style.setProperty('--text-shadow-intensity', isMd3 ? '0%' : '35%')

    // --- shape ---
    html.style.setProperty('--border-radius', resolved.tokens.panelRadius)
    html.style.setProperty('--radius-md', resolved.tokens.controlRadius)

    // --- background glow ---
    html.style.setProperty('--page-glow', resolved.tokens.pageGlow)
    html.style.setProperty('--page-glow-secondary', resolved.tokens.pageGlowSecondary)

    // --- motion ---
    const fast = resolved.motionMode === 'reduced' ? '0ms' : '120ms'
    const base = resolved.motionMode === 'reduced' ? '0ms' : '220ms'
    const slow = resolved.motionMode === 'reduced' ? '0ms' : '360ms'
    html.style.setProperty('--motion-fast', fast)
    html.style.setProperty('--motion-base', base)
    html.style.setProperty('--motion-slow', slow)

    // --- meta theme-color ---
    const themeMeta = document.querySelector('meta[name="theme-color"]')
    if (themeMeta) {
      themeMeta.setAttribute('content', resolved.themeColor)
    }
  }, [
    accentColorOverride,
    accentPreset,
    backgroundColorOverride,
    motionMode,
    primaryColorOverride,
    theme,
  ])

  return null
}
