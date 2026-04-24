'use client'

import { useEffect } from 'react'
import { resolveThemeAppearance, useThemeStore } from '@/store/themeStore'
import { TELEGRAM_BEHAVIOR } from '@/components/chat/telegram-behavior'

/**
 * CHROMATIC_APPLICATOR
 * Single source of truth for theme application.
 * Reads themeStore, resolves tokens, stamps them on <html> via inline CSS vars.
 * No [data-theme] CSS blocks needed — ThemeApplicator owns everything.
 */
export function ThemeApplicator() {
  const theme = useThemeStore((s) => s.theme)
  const shellMode = useThemeStore((s) => s.shellMode)
  const platformProfile = useThemeStore((s) => s.platformProfile)
  const accentPreset = useThemeStore((s) => s.accentPreset)
  const primaryColorOverride = useThemeStore((s) => s.primaryColorOverride)
  const accentColorOverride = useThemeStore((s) => s.accentColorOverride)
  const accentSoftColorOverride = useThemeStore((s) => s.accentSoftColorOverride)
  const backgroundColorOverride = useThemeStore((s) => s.backgroundColorOverride)
  const motionMode = useThemeStore((s) => s.motionMode)

  useEffect(() => {
    const html = document.documentElement
    const isMobileTelegramProfile = platformProfile === 'mobile-tg-ios'
    const resolved = resolveThemeAppearance({
      theme,
      shellMode,
      accentPreset,
      primaryColorOverride,
      accentColorOverride,
      accentSoftColorOverride,
      backgroundColorOverride,
      motionMode,
    })

    // --- color scheme & data-* identifiers ---
    // [data-theme]   = legacy full-combo id (kept for backwards-compat CSS).
    // [data-palette] = new palette dimension (colors only).
    // [data-shell]   = new shell dimension (typography + shape + CRT).
    html.setAttribute('data-theme', resolved.id)
    html.setAttribute('data-palette', resolved.id)
    html.setAttribute('data-shell', resolved.shell.id)
    html.setAttribute('data-platform-profile', platformProfile)
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
    html.style.setProperty('--neon-amber', resolved.tokens.accentSoft)
    html.style.setProperty('--primary', resolved.tokens.primary)
    html.style.setProperty(
      '--on-primary',
      resolved.scheme === 'light' ? '#ffffff' : '#101216'
    )
    html.style.setProperty(
      '--surface-variant',
      `color-mix(in srgb, ${resolved.tokens.surface} 84%, ${resolved.tokens.text} 16%)`
    )
    html.style.setProperty(
      '--on-surface-variant',
      `color-mix(in srgb, ${resolved.tokens.text} 70%, transparent)`
    )
    html.style.setProperty(
      '--secondary-container',
      `color-mix(in srgb, ${resolved.tokens.accent} 20%, ${resolved.tokens.surface})`
    )
    html.style.setProperty(
      '--on-secondary-container',
      `color-mix(in srgb, ${resolved.tokens.text} 92%, transparent)`
    )
    html.style.setProperty(
      '--state-hover',
      `color-mix(in srgb, ${resolved.tokens.text} 8%, transparent)`
    )
    html.style.setProperty(
      '--state-pressed',
      `color-mix(in srgb, ${resolved.tokens.text} 14%, transparent)`
    )
    html.style.setProperty(
      '--state-focus-ring',
      `color-mix(in srgb, ${resolved.tokens.primary} 45%, transparent)`
    )
    html.style.setProperty('--border-strong', resolved.tokens.border)
    html.style.setProperty('--danger', resolved.tokens.danger)
    html.style.setProperty('--success', resolved.tokens.success)
    html.style.setProperty('--warning', resolved.tokens.accentSoft)
    html.style.setProperty('--shadow-rgb', resolved.tokens.shadowRgb)

    // --- CRT effect ---
    html.style.setProperty('--crt-opacity', resolved.tokens.crtOpacity)
    html.style.setProperty('--crt-vignette-opacity', resolved.tokens.crtVignetteOpacity)

    // --- typography & shell chrome ---
    html.style.setProperty('--font-family', resolved.tokens.fontFamily)
    html.style.setProperty(
      '--text-shadow-intensity',
      resolved.shell.textShadowIntensity
    )

    // --- shape (all radius vars must follow shell so no component leaks rounded corners) ---
    const panelR = resolved.tokens.panelRadius
    const ctrlR = resolved.tokens.controlRadius
    html.style.setProperty('--border-radius', panelR)
    html.style.setProperty('--radius-md', ctrlR)
    // Derive sm/lg proportionally from panel/control so they stay consistent.
    // Terminal shell: both are 0px → all stay 0.  MD3 shell: scale naturally.
    html.style.setProperty('--radius-sm', ctrlR === '0px' ? '0px' : '4px')
    html.style.setProperty('--radius-lg', panelR === '0px' ? '0px' : '16px')

    // --- background glow ---
    html.style.setProperty('--page-glow', resolved.tokens.pageGlow)
    html.style.setProperty('--page-glow-secondary', resolved.tokens.pageGlowSecondary)
    html.style.setProperty(
      '--p13-mobile-header-bg',
      isMobileTelegramProfile
        ? `color-mix(in srgb, ${resolved.tokens.surface} 74%, transparent)`
        : `color-mix(in srgb, ${resolved.tokens.surface} 82%, transparent)`
    )
    html.style.setProperty(
      '--p13-touch-target',
      `${isMobileTelegramProfile ? 48 : TELEGRAM_BEHAVIOR.mobile.touchTargetPx}px`
    )
    html.style.setProperty(
      '--p13-mobile-sheet-duration',
      `${isMobileTelegramProfile ? 260 : TELEGRAM_BEHAVIOR.mobile.sheetAnimationMs}ms`
    )
    html.style.setProperty(
      '--p13-keyboard-settle-duration',
      `${isMobileTelegramProfile ? 220 : TELEGRAM_BEHAVIOR.mobile.keyboardSettleMs}ms`
    )
    html.style.setProperty(
      '--p13-header-pad',
      resolved.shell.id === 'md3'
        ? (isMobileTelegramProfile ? '10px 14px' : '8px 12px')
        : (isMobileTelegramProfile ? '8px 10px' : '6px 8px')
    )
    html.style.setProperty(
      '--p13-row-pad',
      resolved.shell.id === 'md3'
        ? (isMobileTelegramProfile ? '12px 16px' : '10px 14px')
        : (isMobileTelegramProfile ? '12px 14px 12px 16px' : '10px 12px 10px 14px')
    )
    html.style.setProperty(
      '--p13-msg-gap',
      isMobileTelegramProfile ? '12px' : resolved.shell.id === 'md3' ? '10px' : '12px'
    )
    html.style.setProperty(
      '--p13-msg-gap-run',
      isMobileTelegramProfile ? '12px' : resolved.shell.id === 'md3' ? '10px' : '12px'
    )
    html.style.setProperty(
      '--p13-date-divider-gap-top',
      isMobileTelegramProfile ? '18px' : resolved.shell.id === 'md3' ? '16px' : '14px'
    )
    html.style.setProperty(
      '--p13-date-divider-gap-bottom',
      isMobileTelegramProfile ? '12px' : resolved.shell.id === 'md3' ? '10px' : '8px'
    )

    // --- motion (shell-aware: MD3 uses Material 3 spec timings) ---
    const isMd3Shell = resolved.shell.id === 'md3'
    const fast = resolved.motionMode === 'reduced' ? '0ms' : isMd3Shell ? '100ms' : '120ms'
    const base = resolved.motionMode === 'reduced' ? '0ms' : isMd3Shell ? '200ms' : '220ms'
    const slow = resolved.motionMode === 'reduced' ? '0ms' : isMd3Shell ? '300ms' : '360ms'
    html.style.setProperty('--motion-fast', fast)
    html.style.setProperty('--motion-base', base)
    html.style.setProperty('--motion-slow', slow)

    // --- meta theme-color (dynamic, per palette) ---
    // Ensure a meta exists (SSR may or may not have emitted one).
    let themeMeta = document.querySelector(
      'meta[name="theme-color"]'
    ) as HTMLMetaElement | null
    if (!themeMeta) {
      themeMeta = document.createElement('meta')
      themeMeta.name = 'theme-color'
      document.head.appendChild(themeMeta)
    }
    themeMeta.setAttribute('content', resolved.themeColor)

    // Separate light/dark variants improve Android Chrome + iOS Safari handling.
    const apply = (media: string) => {
      let m = document.querySelector(
        `meta[name="theme-color"][media="${media}"]`
      ) as HTMLMetaElement | null
      if (!m) {
        m = document.createElement('meta')
        m.name = 'theme-color'
        m.setAttribute('media', media)
        document.head.appendChild(m)
      }
      m.setAttribute('content', resolved.themeColor)
    }
    apply('(prefers-color-scheme: light)')
    apply('(prefers-color-scheme: dark)')

    // iOS PWA standalone status bar.
    let appleStatus = document.querySelector(
      'meta[name="apple-mobile-web-app-status-bar-style"]'
    ) as HTMLMetaElement | null
    if (!appleStatus) {
      appleStatus = document.createElement('meta')
      appleStatus.name = 'apple-mobile-web-app-status-bar-style'
      document.head.appendChild(appleStatus)
    }
    // `black-translucent` gives the smoothest edge-to-edge feel; for light
    // schemes we fall back to `default` to keep the status bar readable.
    appleStatus.setAttribute(
      'content',
      resolved.scheme === 'light' ? 'default' : 'black-translucent'
    )
  }, [
    accentColorOverride,
    accentSoftColorOverride,
    accentPreset,
    backgroundColorOverride,
    motionMode,
    primaryColorOverride,
    platformProfile,
    shellMode,
    theme,
  ])

  return null
}
