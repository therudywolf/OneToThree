import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'
const shouldManageWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER !== '1'

/**
 * Prereq: Fastify API on 8080 (see playwright.global-setup.ts), Postgres + MinIO + `npm run db:push:docker`.
 * This config builds and serves the Next.js app only.
 *
 * Session cookies: leave `NEXT_PUBLIC_API_URL` empty so the browser uses same-origin `/api` (rewritten to
 * Fastify via `API_INTERNAL_URL`). Pointing the client at `:8080` directly breaks `fm_session` + middleware.
 * Run the API with `NODE_ENV=test` and `COOKIE_SECURE` unset so `fm_session` stays `SameSite=Lax` (not
 * `Secure`/`None`): a `Secure` cookie is dropped over plain HTTP. `playwright.global-setup.ts` fails fast if not.
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
    /** Production build registers next-pwa SW; it can intercept `/api/*` and bypass Playwright `page.route`. */
    serviceWorkers: 'block',
    launchOptions: {
      args: [
        // Windows resolves `localhost` to ::1 first, but Docker publishes the
        // e2e stack (scripts/e2e-local.sh → :8090) on IPv4 only — every
        // navigation then dies with ERR_EMPTY_RESPONSE. The base URL must stay
        // `localhost` (it is the origin the web image was built for, so the
        // session cookie and CORS depend on it), hence pin the name instead.
        // No-op where localhost is already IPv4 (Linux/CI).
        '--host-resolver-rules=MAP localhost 127.0.0.1',
      ],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-ios', use: { ...devices['iPhone 14'] } },
  ],
  ...(shouldManageWebServer
    ? {
        webServer: {
          /** Next 16 standalone startup is flaky in local Windows E2E; use the supported start command. */
          command:
            'npm run build && npm run start -- --hostname 127.0.0.1 --port 3000',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
          cwd: '.',
          env: {
            ...process.env,
            PORT: process.env.PORT ?? '3000',
            HOSTNAME: process.env.HOSTNAME ?? '127.0.0.1',
            /** Fastify for `rewrites()` in next.config.js — browser still calls `/api` on :3000. */
            API_INTERNAL_URL: process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8080',
            /** Empty → client `API_URL` is `/api` (same origin as Next). */
            NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? '',
          },
        },
      }
    : {}),
})
