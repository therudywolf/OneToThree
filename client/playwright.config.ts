import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'

/**
 * Prereq: Fastify API on 8080 (see playwright.global-setup.ts), Postgres + MinIO + `npm run db:push:docker`.
 * This config builds and serves the Next.js app only.
 *
 * Stability: E2E hits a live local API + DB (not mocked). Use `reuseExistingServer: !CI` to keep one
 * Next server warm while iterating. For UI-only mocks, prefer `page.route` in a dedicated project.
 */
export default defineConfig({
  globalSetup: './playwright.global-setup.ts',
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run start',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    cwd: '.',
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL:
        process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8080',
    },
  },
})
