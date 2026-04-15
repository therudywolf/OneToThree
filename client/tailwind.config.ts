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
        // CHROMATIC_PROTOCOL :: tokens wired to CSS vars
        // ThemeApplicator stamps data-theme on <html>;
        // globals.css overrides the vars per theme.
        // Tailwind must reference var() so runtime swaps work.
        void: 'var(--void)',
        'neon-red': 'var(--neon-red)',
        'neon-cyan': 'var(--neon-cyan)',
      },
      screens: {
        'xs': '360px',
        'sm-mobile': '430px',
        'mobile-landscape': { raw: '(min-width: 667px) and (max-height: 480px) and (orientation: landscape)' },
        'tablet': '768px',
        'desktop': '1280px',
        'wide': '1920px',
        'ultrawide': { raw: '(min-aspect-ratio: 21/9)' },
        'superwide': { raw: '(min-aspect-ratio: 32/9)' },
        'tall': { raw: '(min-aspect-ratio: 9/16)' },
        'ratio-16-10': { raw: '(min-aspect-ratio: 16/10) and (max-aspect-ratio: 16/9)' },
      },
      fontFamily: {
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
