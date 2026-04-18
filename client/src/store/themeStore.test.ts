import { describe, expect, it } from 'vitest'
import { resolveThemeAppearance } from './themeStore'

describe('theme appearance resolution', () => {
  it('resolves base theme tokens for custom themes', () => {
    const resolved = resolveThemeAppearance({
      theme: 'pixel',
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
  })

  it('applies palette and background overrides without losing theme scheme', () => {
    const resolved = resolveThemeAppearance({
      theme: 'md3light',
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
  })
})
