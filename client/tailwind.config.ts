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
        void: '#000000',
        'neon-red': '#FF0000',
        'neon-cyan': '#00FFFF',
      },
      screens: {
        'xs': '360px',
        'mobile-landscape': { raw: '(min-width: 667px) and (max-height: 480px) and (orientation: landscape)' },
        'tablet': '768px',
        'desktop': '1280px',
        'ultrawide': { raw: '(min-aspect-ratio: 21/9)' },
        'superwide': { raw: '(min-aspect-ratio: 32/9)' },
        'tall': { raw: '(min-aspect-ratio: 9/16)' },
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
