import { describe, expect, it } from 'vitest'
import {
  resolveThemeAppearance,
  THEMES,
  THEME_BY_ID,
  type ThemeId,
  type ThemeTokens,
} from './themeStore'

describe('theme appearance resolution', () => {
  it('resolves base theme tokens for custom themes', () => {
    const resolved = resolveThemeAppearance({
      theme: 'pixel',
      shellMode: 'terminal',
      accentPreset: 'theme',
      primaryColorOverride: null,
      accentColorOverride: null,
      accentSoftColorOverride: null,
      backgroundColorOverride: null,
      motionMode: 'full',
    })

    expect(resolved.id).toBe('pixel')
    expect(resolved.tokens.primary).toBe('#7cc7ff')
    expect(resolved.tokens.accent).toBe('#8df56b')
    expect(resolved.scheme).toBe('dark')
    expect(resolved.shell.id).toBe('terminal')
  })

  it('applies palette and background overrides without losing theme scheme', () => {
    const resolved = resolveThemeAppearance({
      theme: 'md3light',
      shellMode: 'md3',
      accentPreset: 'amber',
      primaryColorOverride: '#112233',
      accentColorOverride: '#445566',
      accentSoftColorOverride: null,
      backgroundColorOverride: '#ddeeff',
      motionMode: 'reduced',
    })

    expect(resolved.scheme).toBe('light')
    expect(resolved.motionMode).toBe('reduced')
    expect(resolved.tokens.primary).toBe('#112233')
    expect(resolved.tokens.accent).toBe('#445566')
    expect(resolved.tokens.background).toBe('#ddeeff')
    expect(resolved.themeColor).toBe('#ddeeff')
    expect(resolved.tokens.surface).not.toBe('#ffffff')
    expect(resolved.shell.id).toBe('md3')
    expect(resolved.tokens.crtOpacity).toBe('0')
  })

  it('shell mode overrides typography+shape regardless of palette', () => {
    const terminalMD3Palette = resolveThemeAppearance({
      theme: 'md3light',
      shellMode: 'terminal',
      accentPreset: 'theme',
      primaryColorOverride: null,
      accentColorOverride: null,
      accentSoftColorOverride: null,
      backgroundColorOverride: null,
      motionMode: 'full',
    })

    expect(terminalMD3Palette.shell.id).toBe('terminal')
    expect(terminalMD3Palette.tokens.fontFamily).toContain('Mono')
    expect(terminalMD3Palette.tokens.crtOpacity).not.toBe('0')
  })

  it('falls back to terminal shell when shellMode omitted and palette non-MD3', () => {
    const resolved = resolveThemeAppearance({
      theme: 'pixel',
      accentPreset: 'theme',
      primaryColorOverride: null,
      accentColorOverride: null,
      accentSoftColorOverride: null,
      backgroundColorOverride: null,
      motionMode: 'full',
    })
    expect(resolved.shell.id).toBe('terminal')
  })

  it('keeps platform profile orthogonal to palette and shell state', () => {
    const resolved = resolveThemeAppearance({
      theme: 'cyberpunk2077',
      shellMode: 'md3',
      accentPreset: 'theme',
      primaryColorOverride: null,
      accentColorOverride: null,
      accentSoftColorOverride: null,
      backgroundColorOverride: null,
      motionMode: 'full',
    })

    expect(resolved.id).toBe('cyberpunk2077')
    expect(resolved.shell.id).toBe('md3')
  })

  it('applies explicit accentSoft override and exposes 4-color preview', () => {
    const resolved = resolveThemeAppearance({
      theme: 'pixel',
      shellMode: 'terminal',
      accentPreset: 'theme',
      primaryColorOverride: null,
      accentColorOverride: '#445566',
      accentSoftColorOverride: '#112233',
      backgroundColorOverride: null,
      motionMode: 'full',
    })

    expect(resolved.tokens.accent).toBe('#445566')
    expect(resolved.tokens.accentSoft).toBe('#112233')
    expect(resolved.preview).toEqual([
      resolved.tokens.background,
      resolved.tokens.primary,
      resolved.tokens.accent,
      resolved.tokens.accentSoft,
    ])
  })

  it('keeps theme-provided accent 2 when no overrides are set', () => {
    const resolved = resolveThemeAppearance({
      theme: 'default',
      shellMode: 'terminal',
      accentPreset: 'theme',
      primaryColorOverride: null,
      accentColorOverride: null,
      accentSoftColorOverride: null,
      backgroundColorOverride: null,
      motionMode: 'full',
    })

    expect(resolved.tokens.accent).toBe('#00e8ff')
    expect(resolved.tokens.accentSoft).toBe('#ffb347')
  })
})

describe('theme catalogue integrity', () => {
  // Every key the ThemeApplicator + FOUC baseline rely on. Keep in sync with
  // the ThemeTokens type in themeStore.ts.
  const REQUIRED_TOKEN_KEYS: Array<keyof ThemeTokens> = [
    'background',
    'surface',
    'elevated',
    'text',
    'muted',
    'primary',
    'accent',
    'accentSoft',
    'border',
    'success',
    'danger',
    'shadowRgb',
    'crtOpacity',
    'crtVignetteOpacity',
    'fontFamily',
    'panelRadius',
    'controlRadius',
    'pageGlow',
    'pageGlowSecondary',
  ]

  const ALL_THEME_IDS: ThemeId[] = [
    'default',
    'cyberpunk2077',
    'retro',
    'matrix',
    'dracula',
    'midnight',
    'synthwave',
    'hacker',
    'pixel',
    'nord',
    'md3dark',
    'md3light',
  ]

  it('exposes one ThemeConfig per ThemeId with no duplicates', () => {
    expect(THEMES).toHaveLength(ALL_THEME_IDS.length)
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(ALL_THEME_IDS.length)
    for (const id of ALL_THEME_IDS) {
      expect(THEME_BY_ID[id]?.id).toBe(id)
    }
  })

  it('every theme provides the full ThemeTokens set with non-empty values', () => {
    for (const theme of THEMES) {
      for (const key of REQUIRED_TOKEN_KEYS) {
        const value = theme.tokens[key]
        expect(
          typeof value === 'string' && value.trim().length > 0,
          `${theme.id}.tokens.${key} must be a non-empty string`
        ).toBe(true)
      }
    }
  })
})
