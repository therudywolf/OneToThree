import { describe, expect, it } from 'vitest'
import { resolveThemeAppearance } from './themeStore'

describe('theme appearance resolution', () => {
  it('resolves base theme tokens for custom themes', () => {
    const resolved = resolveThemeAppearance({
      theme: 'pixel',
      shellMode: 'terminal',
      accentPreset: 'theme',
      primaryColorOverride: null,
      accentColorOverride: null,
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
      backgroundColorOverride: null,
      motionMode: 'full',
    })
    expect(resolved.shell.id).toBe('terminal')
  })
})
