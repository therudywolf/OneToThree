import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Default env is node (keeps the existing pure-logic unit tests fast).
    // Component tests opt into jsdom per-file via `// @vitest-environment jsdom`.
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/types/**',
        'src/locales/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
