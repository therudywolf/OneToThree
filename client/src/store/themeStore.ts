'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeJSONStorage } from '@/lib/safe-zustand-storage'

/**
 * ============================================================================
 * THEME MODEL — read this before editing.
 * ============================================================================
 *
 * Conceptually there are THREE visual identities, not twelve themes:
 *
 *   1. TERMINAL (Cyberpunk identity) — monospace type, CRT scanline overlay,
 *      sharp/near-sharp corners. The original "FaceMash terminal" look.
 *   2. RETRO — the Windows 98 / XP / ICQ classic look. Skinned almost entirely
 *      by `[data-theme="retro"]` component rules in globals.css. It runs on the
 *      'terminal' shell internally (it is terminal-only — see the retro coercion
 *      in `setTheme` / `resolveThemeAppearance`), but visually it is its own
 *      identity.
 *   3. MD3 — Material Design 3: Google Sans / Roboto, rounded corners, flat
 *      (no CRT), Material motion timings.
 *
 * Two orthogonal dimensions express that:
 *
 *   - `ShellModeId` ('terminal' | 'md3') = typography + shape + CRT chrome.
 *   - the color PALETTE = the `tokens` of a `ThemeConfig` (`THEMES` below).
 *
 * `ThemeId` is a HALF-FINISHED migration artifact: today each `THEMES` entry is
 * a flat (palette [+ baked-in shell hint]) combo rather than a pure palette.
 * The 12 ids therefore group onto the 3 identities like this:
 *
 *   TERMINAL identity (terminal shell + a palette):
 *     default · cyberpunk2077 · matrix · dracula · midnight ·
 *     synthwave · hacker · pixel · nord
 *     (cyberpunk2077 additionally keeps its own near-square panel/control
 *      radii — see the override at the end of `resolveThemeAppearance`.)
 *
 *   RETRO identity:
 *     retro   (terminal shell only; md3 shell is coerced away for it)
 *
 *   MD3 identity (md3 shell + a palette):
 *     md3dark · md3light
 *
 * `ThemeApplicator` (components/theme-applicator.tsx) is the single source of
 * truth at runtime: it calls `resolveThemeAppearance`, then stamps the result
 * onto <html> as inline CSS variables (inline styles win the cascade). The
 * `[data-theme="X"] { --var: ... }` blocks in globals.css only provide the
 * pre-hydration FOUC baseline and MUST be kept in sync with the `makeTheme()`
 * tokens below.
 *
 * DO NOT rename `ThemeId` values — they are persisted in localStorage under
 * `fm_chromatic_config` and a rename would break the migration. A proper
 * "3 palettes × 3 shells" restructure is deferred; keep ids stable.
 * ============================================================================
 */
export type ThemeId =
  | 'default'
  | 'cyberpunk2077'
  | 'retro'
  | 'matrix'
  | 'dracula'
  | 'midnight'
  | 'synthwave'
  | 'hacker'
  | 'pixel'
  | 'nord'
  | 'md3dark'
  | 'md3light'

export type MotionMode = 'full' | 'reduced'
export type PlatformProfileId = 'desktop-tg' | 'mobile-tg-ios'

/**
 * Shell mode = typography + shape + "CRT" chrome for the entire UI.
 * Independent of the palette (colors). Two shells are shipped:
 *   - 'terminal'  — monospace, sharp corners, CRT overlay (legacy).
 *   - 'md3'       — Material Design 3: Google Sans / Roboto, rounded corners, no CRT.
 */
export type ShellModeId = 'terminal' | 'md3'

export type ShellPreset = {
  id: ShellModeId
  label: string
  hint: string
  fontFamily: string
  panelRadius: string
  controlRadius: string
  crtOpacity: string
  crtVignetteOpacity: string
  /** CSS percentage string, e.g. '35%' or '0%' for MD3. */
  textShadowIntensity: string
}

export const SHELL_PRESETS: ShellPreset[] = [
  {
    id: 'terminal',
    label: 'TERMINAL',
    hint: 'Monospace / CRT / sharp corners',
    fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    panelRadius: '0px',
    controlRadius: '0px',
    crtOpacity: '0.16',
    crtVignetteOpacity: '0.4',
    textShadowIntensity: '35%',
  },
  {
    id: 'md3',
    label: 'MATERIAL 3',
    hint: 'Google Sans / rounded / flat',
    fontFamily: "'Google Sans', 'Roboto', system-ui, sans-serif",
    panelRadius: '28px',
    controlRadius: '18px',
    crtOpacity: '0',
    crtVignetteOpacity: '0',
    textShadowIntensity: '0%',
  },
]

export const SHELL_PRESET_BY_ID: Record<ShellModeId, ShellPreset> =
  SHELL_PRESETS.reduce(
    (acc, preset) => {
      acc[preset.id] = preset
      return acc
    },
    {} as Record<ShellModeId, ShellPreset>
  )

export type ThemeTokens = {
  background: string
  surface: string
  elevated: string
  text: string
  muted: string
  primary: string
  accent: string
  accentSoft: string
  border: string
  success: string
  danger: string
  shadowRgb: string
  crtOpacity: string
  crtVignetteOpacity: string
  fontFamily: string
  panelRadius: string
  controlRadius: string
  pageGlow: string
  pageGlowSecondary: string
}

export interface ThemeConfig {
  id: ThemeId
  label: string
  scheme: 'dark' | 'light'
  themeColor: string
  preview: [string, string, string, string]
  tokens: ThemeTokens
}

export type AccentPresetId =
  | 'theme'
  | 'signal'
  | 'mint'
  | 'amber'
  | 'violet'
  | 'sunset'
  | 'mono'

export type AccentPreset = {
  id: AccentPresetId
  label: string
  primary: string
  accent: string
}

const VOID_PRIMARY = '#ff2a3d'
const VOID_ACCENT = '#00e8ff'
const VOID_AMBER = '#ffb347'

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!HEX_RE.test(trimmed)) return null
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return trimmed.toLowerCase()
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex) ?? '#000000'
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ]
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0'))
    .join('')}`
}

function mixColors(base: string, target: string, weight: number): string {
  const [br, bg, bb] = hexToRgb(base)
  const [tr, tg, tb] = hexToRgb(target)
  const alpha = clamp01(weight)
  return rgbToHex(
    br + (tr - br) * alpha,
    bg + (tg - bg) * alpha,
    bb + (tb - bb) * alpha
  )
}

function rgbTriplet(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `${r}, ${g}, ${b}`
}

function makeTheme(
  id: ThemeId,
  label: string,
  scheme: 'dark' | 'light',
  tokens: ThemeTokens
): ThemeConfig {
  return {
    id,
    label,
    scheme,
    themeColor: tokens.background,
    preview: [tokens.background, tokens.primary, tokens.accent, tokens.accentSoft],
    tokens,
  }
}

export const THEMES: ThemeConfig[] = [
  makeTheme('default', '13 // DEFAULT', 'dark', {
    background: '#05070a',
    surface: '#0d1218',
    elevated: '#111923',
    text: '#ebf4ff',
    muted: '#92a0b7',
    primary: VOID_PRIMARY,
    accent: VOID_ACCENT,
    accentSoft: VOID_AMBER,
    border: '#1e2b39',
    success: VOID_AMBER,
    danger: '#ff6262',
    shadowRgb: '77, 243, 255',
    crtOpacity: '0.16',
    crtVignetteOpacity: '0.4',
    fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    panelRadius: '18px',
    controlRadius: '14px',
    pageGlow: '#0d2540',
    pageGlowSecondary: '#2d0f2f',
  }),
  makeTheme('cyberpunk2077', 'CYBERPUNK 2077', 'dark', {
    background: '#12090c',
    surface: '#1b1014',
    elevated: '#24151d',
    text: '#ffe7c2',
    muted: '#c3aa87',
    primary: '#ff5f3d',
    accent: '#2ff3ff',
    accentSoft: '#ffc166',
    border: '#4a3320',
    success: VOID_AMBER,
    danger: '#ff5d4a',
    shadowRgb: '51, 240, 255',
    crtOpacity: '0.12',
    crtVignetteOpacity: '0.32',
    fontFamily: "'Space Mono', 'IBM Plex Mono', ui-monospace, monospace",
    panelRadius: '0px',
    controlRadius: '0px',
    pageGlow: '#452600',
    pageGlowSecondary: '#4a0830',
  }),
  makeTheme('retro', 'RETRO // CLASSIC', 'dark', {
    background: '#efe6c5',
    surface: '#ddd3ae',
    elevated: '#ebe0ba',
    text: '#111111',
    muted: '#3c4653',
    primary: '#7f6630',
    accent: '#2f7a6e',
    accentSoft: '#f2c94c',
    border: '#8a7f60',
    success: '#1b7c3c',
    danger: '#b0383a',
    shadowRgb: '127, 102, 48',
    crtOpacity: '0.05',
    crtVignetteOpacity: '0.14',
    fontFamily: "'Tahoma', 'Verdana', 'MS Sans Serif', sans-serif",
    panelRadius: '6px',
    controlRadius: '4px',
    pageGlow: '#103a8c',
    pageGlowSecondary: '#0a2a6b',
  }),
  makeTheme('matrix', 'MATRIX // GREEN', 'dark', {
    background: '#020603',
    surface: '#08110a',
    elevated: '#0b180d',
    text: '#b8ffd1',
    muted: '#5f9670',
    primary: '#6bff75',
    accent: '#00d26a',
    accentSoft: '#44ff9b',
    border: '#17341f',
    success: '#7dff95',
    danger: '#ff6464',
    shadowRgb: '0, 210, 106',
    crtOpacity: '0.2',
    crtVignetteOpacity: '0.5',
    fontFamily: "'VT323', 'IBM Plex Mono', ui-monospace, monospace",
    panelRadius: '10px',
    controlRadius: '10px',
    pageGlow: '#0b2c12',
    pageGlowSecondary: '#041a10',
  }),
  makeTheme('dracula', 'DRACULA', 'dark', {
    background: '#242532',
    surface: '#2d3041',
    elevated: '#383b52',
    text: '#f8f8f2',
    muted: '#b8b6cc',
    primary: '#ff79c6',
    accent: '#8be9fd',
    accentSoft: '#c6f7ff',
    border: '#4a4f6c',
    success: '#50fa7b',
    danger: '#ff5555',
    shadowRgb: '139, 233, 253',
    crtOpacity: '0.08',
    crtVignetteOpacity: '0.2',
    fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    panelRadius: '20px',
    controlRadius: '14px',
    pageGlow: '#4a1e49',
    pageGlowSecondary: '#1f3650',
  }),
  makeTheme('midnight', 'MIDNIGHT BLUE', 'dark', {
    background: '#09131f',
    surface: '#101c2e',
    elevated: '#16253b',
    text: '#edf7ff',
    muted: '#8da6c0',
    primary: '#8dc5ff',
    accent: '#59f0ff',
    accentSoft: '#b4fbff',
    border: '#233750',
    success: '#37d8a6',
    danger: '#ff7c7c',
    shadowRgb: '89, 240, 255',
    crtOpacity: '0.1',
    crtVignetteOpacity: '0.28',
    fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    panelRadius: '20px',
    controlRadius: '14px',
    pageGlow: '#113c68',
    pageGlowSecondary: '#0f2959',
  }),
  makeTheme('synthwave', 'SYNTHWAVE // RETRO', 'dark', {
    background: '#12061f',
    surface: '#1b0b2c',
    elevated: '#281144',
    text: '#ffe9ff',
    muted: '#d2a6dc',
    primary: '#ff4fb7',
    accent: '#7b7dff',
    accentSoft: '#c0bcff',
    border: '#49256a',
    success: '#3de8b7',
    danger: '#ff7b8c',
    shadowRgb: '123, 125, 255',
    crtOpacity: '0.14',
    crtVignetteOpacity: '0.28',
    fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    panelRadius: '18px',
    controlRadius: '14px',
    pageGlow: '#4a0c4f',
    pageGlowSecondary: '#172978',
  }),
  makeTheme('hacker', 'HACKER // AMBER', 'dark', {
    background: '#0f0d06',
    surface: '#17130a',
    elevated: '#231d10',
    text: '#fff0c7',
    muted: '#d1b784',
    primary: '#ffbe3d',
    accent: '#ff7a00',
    accentSoft: '#ffc774',
    border: '#4a371a',
    success: '#7fe060',
    danger: '#ff6b4a',
    shadowRgb: '255, 190, 61',
    crtOpacity: '0.18',
    crtVignetteOpacity: '0.42',
    fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    panelRadius: '12px',
    controlRadius: '12px',
    pageGlow: '#4a3000',
    pageGlowSecondary: '#3f1900',
  }),
  makeTheme('pixel', 'PIXEL EXPERIENCE', 'dark', {
    background: '#101521',
    surface: '#182033',
    elevated: '#232d45',
    text: '#eff5ff',
    muted: '#9da9bf',
    primary: '#7cc7ff',
    accent: '#8df56b',
    accentSoft: '#f9da69',
    border: '#32415f',
    success: '#6cf7a0',
    danger: '#ff7676',
    shadowRgb: '141, 245, 107',
    crtOpacity: '0.06',
    crtVignetteOpacity: '0.18',
    fontFamily: "'Space Mono', 'IBM Plex Mono', ui-monospace, monospace",
    panelRadius: '22px',
    controlRadius: '16px',
    pageGlow: '#143b63',
    pageGlowSecondary: '#32492a',
  }),
  makeTheme('nord', 'NORD FROST', 'dark', {
    background: '#111725',
    surface: '#182131',
    elevated: '#202c40',
    text: '#eaf2ff',
    muted: '#92a1bc',
    primary: '#88c0d0',
    accent: '#81a1ff',
    accentSoft: '#d2dfff',
    border: '#31415d',
    success: '#98d8aa',
    danger: '#ff7d7d',
    shadowRgb: '129, 161, 255',
    crtOpacity: '0.06',
    crtVignetteOpacity: '0.16',
    fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
    panelRadius: '22px',
    controlRadius: '16px',
    pageGlow: '#203f63',
    pageGlowSecondary: '#283457',
  }),
  makeTheme('md3dark', 'MD3 // DARK', 'dark', {
    background: '#111318',
    surface: '#1b1f27',
    elevated: '#252a34',
    text: '#e4e8ef',
    muted: '#aab1bd',
    primary: '#a8c7fa',
    accent: '#7ed0ff',
    accentSoft: '#d8ecff',
    border: '#353c48',
    success: '#84d59f',
    danger: '#ff8f8f',
    shadowRgb: '168, 199, 250',
    crtOpacity: '0',
    crtVignetteOpacity: '0',
    fontFamily: "'Google Sans', 'Roboto', system-ui, sans-serif",
    panelRadius: '28px',
    controlRadius: '18px',
    pageGlow: '#23334c',
    pageGlowSecondary: '#213746',
  }),
  makeTheme('md3light', 'MD3 // LIGHT', 'light', {
    background: '#f5f7fb',
    surface: '#ffffff',
    elevated: '#eef3fb',
    text: '#171c24',
    muted: '#5d6777',
    primary: '#005ea8',
    accent: '#00639b',
    accentSoft: '#7bc7ff',
    border: '#d8e1ee',
    success: '#1f8f65',
    danger: '#c85656',
    shadowRgb: '0, 99, 155',
    crtOpacity: '0',
    crtVignetteOpacity: '0',
    fontFamily: "'Google Sans', 'Roboto', system-ui, sans-serif",
    panelRadius: '28px',
    controlRadius: '18px',
    pageGlow: '#cfe6ff',
    pageGlowSecondary: '#dbe7f4',
  }),
]

export const THEME_BY_ID: Record<ThemeId, ThemeConfig> = THEMES.reduce(
  (acc, theme) => {
    acc[theme.id] = theme
    return acc
  },
  {} as Record<ThemeId, ThemeConfig>
)

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'theme', label: 'Theme', primary: '', accent: '' },
  { id: 'signal', label: 'Signal', primary: VOID_PRIMARY, accent: VOID_ACCENT },
  { id: 'mint', label: 'Mint', primary: VOID_PRIMARY, accent: VOID_ACCENT },
  { id: 'amber', label: 'Amber', primary: VOID_PRIMARY, accent: VOID_AMBER },
  { id: 'violet', label: 'Violet', primary: VOID_PRIMARY, accent: VOID_ACCENT },
  { id: 'sunset', label: 'Sunset', primary: VOID_PRIMARY, accent: VOID_AMBER },
  { id: 'mono', label: 'Mono', primary: VOID_PRIMARY, accent: VOID_ACCENT },
]

export const ACCENT_PRESET_BY_ID: Record<AccentPresetId, AccentPreset> =
  ACCENT_PRESETS.reduce(
    (acc, preset) => {
      acc[preset.id] = preset
      return acc
    },
    {} as Record<AccentPresetId, AccentPreset>
  )

export type ResolvedThemeAppearance = {
  id: ThemeId
  label: string
  scheme: 'dark' | 'light'
  themeColor: string
  preview: [string, string, string, string]
  tokens: ThemeTokens
  motionMode: MotionMode
  shell: ShellPreset
}

type ChromaticState = {
  theme: ThemeId
  shellMode: ShellModeId
  platformProfile: PlatformProfileId
  accentPreset: AccentPresetId
  primaryColorOverride: string | null
  accentColorOverride: string | null
  accentSoftColorOverride: string | null
  backgroundColorOverride: string | null
  motionMode: MotionMode
  setTheme: (id: ThemeId) => void
  setShellMode: (mode: ShellModeId) => void
  setPlatformProfile: (profile: PlatformProfileId) => void
  setAccentPreset: (id: AccentPresetId) => void
  setPrimaryColorOverride: (value: string | null) => void
  setAccentColorOverride: (value: string | null) => void
  setAccentSoftColorOverride: (value: string | null) => void
  setBackgroundColorOverride: (value: string | null) => void
  setMotionMode: (mode: MotionMode) => void
  resetAppearance: () => void
}

/**
 * Best-effort mapping from legacy `theme` value (that used to encode both
 * palette and shell) to the new `shellMode`. Used only for migration of
 * older persisted state that predates the shell/palette split.
 */
function inferShellFromLegacyTheme(theme: ThemeId | undefined): ShellModeId {
  if (theme === 'md3dark' || theme === 'md3light') return 'md3'
  if (theme === 'cyberpunk2077') return 'terminal'
  return 'terminal'
}

function inferDefaultPlatformProfile(): PlatformProfileId {
  if (typeof window === 'undefined') return 'desktop-tg'

  const hasCapacitor = Boolean(
    (window as typeof window & {
      Capacitor?: { isNativePlatform?: () => boolean }
    }).Capacitor?.isNativePlatform?.()
  )
  if (hasCapacitor) return 'mobile-tg-ios'

  const isNarrowViewport =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 768px)').matches
  if (isNarrowViewport) return 'mobile-tg-ios'

  const userAgent =
    typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : ''
  if (/iphone|ipad|ipod|android|mobile/.test(userAgent)) {
    return 'mobile-tg-ios'
  }

  return 'desktop-tg'
}

export function resolveThemeAppearance(input: Pick<
  ChromaticState,
  | 'theme'
  | 'accentPreset'
  | 'primaryColorOverride'
  | 'accentColorOverride'
  | 'accentSoftColorOverride'
  | 'backgroundColorOverride'
  | 'motionMode'
> & { shellMode?: ShellModeId }): ResolvedThemeAppearance {
  const base = THEME_BY_ID[input.theme] ?? THEME_BY_ID.default
  // retro theme is terminal-only; override any stored md3 shellMode to prevent
  // the MD3 layout shell from being applied when the user switches to retro.
  const rawShellId: ShellModeId =
    input.shellMode ?? inferShellFromLegacyTheme(input.theme)
  const shellId: ShellModeId =
    input.theme === 'retro' && rawShellId === 'md3' ? 'terminal' : rawShellId
  const shell = SHELL_PRESET_BY_ID[shellId] ?? SHELL_PRESET_BY_ID.terminal
  const preset =
    input.accentPreset !== 'theme'
      ? ACCENT_PRESET_BY_ID[input.accentPreset]
      : null

  const primary =
    normalizeHex(input.primaryColorOverride) ??
    normalizeHex(preset?.primary) ??
    base.tokens.primary
  const accent =
    normalizeHex(input.accentColorOverride) ??
    normalizeHex(preset?.accent) ??
    base.tokens.accent
  const background =
    normalizeHex(input.backgroundColorOverride) ?? base.tokens.background

  const surface =
    background !== base.tokens.background
      ? mixColors(
          background,
          base.scheme === 'light' ? '#ffffff' : '#151a22',
          base.scheme === 'light' ? 0.82 : 0.55
        )
      : base.tokens.surface
  const elevated =
    background !== base.tokens.background
      ? mixColors(
          background,
          base.scheme === 'light' ? '#ffffff' : '#202735',
          base.scheme === 'light' ? 0.68 : 0.7
        )
      : base.tokens.elevated

  const accentSoft =
    normalizeHex(input.accentSoftColorOverride) ??
    (input.accentPreset === 'theme'
      ? base.tokens.accentSoft
      : mixColors(
          accent,
          base.scheme === 'light' ? '#ffffff' : '#d9faff',
          base.scheme === 'light' ? 0.45 : 0.2
        ))

  const tokens: ThemeTokens = {
    ...base.tokens,
    background,
    surface,
    elevated,
    primary,
    accent,
    accentSoft,
    border:
      base.id === 'md3dark' || base.id === 'md3light'
        ? base.tokens.border
        : mixColors(accent, background, base.scheme === 'light' ? 0.82 : 0.68),
    shadowRgb: rgbTriplet(accent),
    pageGlow: mixColors(primary, background, base.scheme === 'light' ? 0.68 : 0.26),
    pageGlowSecondary: mixColors(accent, background, base.scheme === 'light' ? 0.72 : 0.22),
    success: base.tokens.success,
    // Shell preset owns typography + shape + CRT:
    fontFamily: shell.fontFamily,
    panelRadius: shell.panelRadius,
    controlRadius: shell.controlRadius,
    crtOpacity: shell.crtOpacity,
    crtVignetteOpacity: shell.crtVignetteOpacity,
  }

  // Night City: palette tokens carry near-square radii; keep monospace + CRT from terminal shell.
  if (input.theme === 'cyberpunk2077') {
    tokens.panelRadius = base.tokens.panelRadius
    tokens.controlRadius = base.tokens.controlRadius
  }

  return {
    id: base.id,
    label: base.label,
    scheme: base.scheme,
    themeColor: background,
    preview: [background, primary, accent, tokens.accentSoft],
    tokens,
    motionMode: input.motionMode,
    shell,
  }
}

export const useThemeStore = create<ChromaticState>()(
  persist(
    (set) => ({
      theme: 'default',
      shellMode: 'terminal',
      platformProfile: inferDefaultPlatformProfile(),
      accentPreset: 'theme',
      primaryColorOverride: null,
      accentColorOverride: null,
      accentSoftColorOverride: null,
      backgroundColorOverride: null,
      motionMode: 'full',
      setTheme: (id) => set((s) => ({
        theme: id,
        // retro is terminal-only; auto-coerce shell so the stored value stays consistent
        shellMode: id === 'retro' && s.shellMode === 'md3' ? 'terminal' : s.shellMode,
      })),
      setShellMode: (mode) => set({ shellMode: mode }),
      setPlatformProfile: (profile) => set({ platformProfile: profile }),
      setAccentPreset: (id) => {
        const preset = ACCENT_PRESET_BY_ID[id]
        set({
          accentPreset: id,
          primaryColorOverride: preset && id !== 'theme' ? preset.primary : null,
          accentColorOverride: preset && id !== 'theme' ? preset.accent : null,
          // Keep Accent 2 derived from the selected preset/theme unless user edits it explicitly.
          accentSoftColorOverride: null,
        })
      },
      setPrimaryColorOverride: (value) =>
        set({
          accentPreset: 'theme',
          primaryColorOverride: normalizeHex(value),
        }),
      setAccentColorOverride: (value) =>
        set({
          accentPreset: 'theme',
          accentColorOverride: normalizeHex(value),
        }),
      setAccentSoftColorOverride: (value) =>
        set({
          accentSoftColorOverride: normalizeHex(value),
        }),
      setBackgroundColorOverride: (value) =>
        set({
          backgroundColorOverride: normalizeHex(value),
        }),
      setMotionMode: (mode) => set({ motionMode: mode }),
      resetAppearance: () =>
        set({
          accentPreset: 'theme',
          primaryColorOverride: null,
          accentColorOverride: null,
          accentSoftColorOverride: null,
          backgroundColorOverride: null,
          motionMode: 'full',
        }),
    }),
    {
      name: 'fm_chromatic_config',
      version: 3,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        theme: state.theme,
        shellMode: state.shellMode,
        platformProfile: state.platformProfile,
        accentPreset: state.accentPreset,
        primaryColorOverride: state.primaryColorOverride,
        accentColorOverride: state.accentColorOverride,
        accentSoftColorOverride: state.accentSoftColorOverride,
        backgroundColorOverride: state.backgroundColorOverride,
        motionMode: state.motionMode,
      }),
      migrate: (persisted, fromVersion) => {
        if (!persisted || typeof persisted !== 'object') return persisted
        if (fromVersion < 2) {
          const state = persisted as Partial<ChromaticState>
          if (state.shellMode === undefined) {
            state.shellMode = inferShellFromLegacyTheme(state.theme)
          }
          if (state.platformProfile === undefined) {
            state.platformProfile = inferDefaultPlatformProfile()
          }
          return state
        }
        if (fromVersion < 3) {
          const state = persisted as Partial<ChromaticState>
          if (state.platformProfile === undefined) {
            state.platformProfile = inferDefaultPlatformProfile()
          }
          return state
        }
        return persisted
      },
    }
  )
)
