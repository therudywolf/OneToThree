import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/hooks/**/*.{js,ts,jsx,tsx,mdx}',
    './src/lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // CHROMATIC_PROTOCOL :: all tokens wired to CSS vars set by ThemeApplicator.
        // No hardcoded values — runtime swap via var() only.
        void: 'var(--void)',
        surface: 'var(--surface)',
        'surface-elevated': 'var(--surface-elevated)',
        elevated: 'var(--surface-elevated)',
        'on-surface': 'var(--on-surface)',
        'text-primary': 'var(--text-primary)',
        'text-muted': 'var(--text-muted)',
        muted: 'var(--text-muted)',
        primary: 'var(--neon-red)',
        accent: 'var(--neon-cyan)',
        'neon-red': 'var(--neon-red)',
        'neon-cyan': 'var(--neon-cyan)',
        'neon-amber': 'var(--neon-amber)',
        'accent-2': 'var(--accent-2)',
        'border-strong': 'var(--border-strong)',
        border: 'var(--border-strong)',
        danger: 'var(--danger)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        // Semantic overlays for hover/press states — tied to tokens, not palette.
        overlay: 'color-mix(in srgb, var(--on-surface) 6%, transparent)',
        'overlay-strong': 'color-mix(in srgb, var(--on-surface) 12%, transparent)',
      },
      fontFamily: {
        // font-theme references the CSS var set by ThemeApplicator per theme
        theme: ['var(--font-family)'],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'monospace',
        ],
      },
      screens: {
        'xs': '360px',
        'sm-mobile': '430px',
        'tablet': '768px',
        'desktop': '1280px',
        'wide': '1920px',
      },
      borderRadius: {
        none: '0',
      },
      keyframes: {
        'neon-pulse': {
          '0%, 100%': {
            boxShadow:
              'inset 0 0 0 1px rgba(0,255,255,0.35), 0 0 8px rgba(0,255,255,0.25)',
          },
          '50%': {
            boxShadow:
              'inset 0 0 0 1px rgba(255,0,0,0.45), 0 0 16px rgba(0,255,255,0.55)',
          },
        },
      },
      animation: {
        'neon-pulse': 'neon-pulse 2.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
export default config
